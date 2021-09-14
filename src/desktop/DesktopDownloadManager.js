// @flow
import type {ElectronSession} from 'electron'
import type {DesktopConfig} from "./config/DesktopConfig"
import path from "path"
import {assertNotNull, downcast, noOp} from "../api/common/utils/Utils"
import {lang} from "../misc/LanguageViewModel"
import type {DesktopNetworkClient} from "./DesktopNetworkClient"
import {FileOpenError} from "../api/common/error/FileOpenError"
import {log} from "./DesktopLog";
import {looksExecutable, nonClobberingFilename} from "./PathUtils"
import type {DesktopUtils} from "./DesktopUtils"
import {promises as fs} from "fs"
import type {DateProvider} from "../calendar/date/CalendarUtils"
import {CancelledError} from "../api/common/error/CancelledError"
import type {NativeDownloadResult} from "../native/common/FileApp"

const TAG = "[DownloadManager]"

export class DesktopDownloadManager {
	_conf: DesktopConfig;
	_net: DesktopNetworkClient;
	_dateProvider: DateProvider;
	/** We don't want to spam opening file manager all the time so we throttle it. This field is set to the last time we opened it. */
	_lastOpenedFileManagerAt: ?number;
	_desktopUtils: DesktopUtils;
	_fs: $Exports<"fs">;
	_electron: $Exports<"electron">
	_topLevelDownloadDir: string

	constructor(
		conf: DesktopConfig,
		net: DesktopNetworkClient,
		desktopUtils: DesktopUtils,
		dateProvider: DateProvider,
		fs: $Exports<"fs">,
		electron: $Exports<"electron">
	) {
		this._conf = conf
		this._net = net
		this._dateProvider = dateProvider
		this._lastOpenedFileManagerAt = null
		this._desktopUtils = desktopUtils
		this._fs = fs
		this._electron = electron
		this._topLevelDownloadDir = "tutanota"
	}

	manageDownloadsForSession(session: ElectronSession, dictUrl: string) {
		dictUrl = dictUrl + "/dictionaries/"
		log.debug(TAG, "getting dictionaries from:", dictUrl)
		session.setSpellCheckerDictionaryDownloadURL(dictUrl)
		session.removeAllListeners('spellcheck-dictionary-download-failure')
		       .on("spellcheck-dictionary-initialized", (ev, lcode) => log.debug(TAG, "spellcheck-dictionary-initialized", lcode))
		       .on("spellcheck-dictionary-download-begin", (ev, lcode) => log.debug(TAG, "spellcheck-dictionary-download-begin", lcode))
		       .on("spellcheck-dictionary-download-success", (ev, lcode) => log.debug(TAG, "spellcheck-dictionary-download-success", lcode))
		       .on("spellcheck-dictionary-download-failure", (ev, lcode) => log.debug(TAG, "spellcheck-dictionary-download-failure", lcode))
	}

	async downloadNative(url: string, headers: Params, filename: string): Promise<NativeDownloadResult> {
		return new Promise(async (resolve, reject) => {
			const downloadDirectory = await this.getTutanotaTempDirectory("download")
			const encryptedFileUri = path.join(downloadDirectory, filename)
			const fileStream = this._fs.createWriteStream(encryptedFileUri)
			                       .on('close', () => resolve({
				                       statusCode: 200,
				                       encryptedFileUri: encryptedFileUri
			                       }))

			let cleanup = e => {
				cleanup = noOp
				fileStream.removeAllListeners('close')
				          .on('close', () => { // file descriptor was released
					          fileStream.removeAllListeners('close')
					          // remove file if it was already created
					          this._fs.promises.unlink(encryptedFileUri)
					              .catch(noOp)
					              .then(() => reject(e))
				          })
				          .end() // {end: true} doesn't work when response errors
			}

			this._net.request(url.toString(), {method: "GET", timeout: 20000, headers: headers})
			    .on('response', response => {
				    response.on('error', cleanup)
				    if (response.statusCode !== 200) {
					    // TODO: Make a specific error here?
					    response.destroy(new Error(response.statusCode)) // causes 'error' event, triggers cleanup in error handler
				    }
				    response.pipe(fileStream) // closes fileStream when done piping
			    })
			    .on('error', cleanup)
			    .end()
		})
	}


	open(itemPath: string): Promise<void> {
		const tryOpen = () => this._electron.shell
		                          .openPath(itemPath) // may resolve with "" or an error message
		                          .catch(() => 'failed to open path.')
		                          .then(errMsg => errMsg === ''
			                          ? Promise.resolve()
			                          : Promise.reject(new FileOpenError("Could not open " + itemPath + ", " + errMsg))
		                          )
		if (looksExecutable(itemPath)) {
			return this._electron.dialog.showMessageBox(null, {
				type: "warning",
				buttons: [lang.get("yes_label"), lang.get("no_label")],
				title: lang.get("executableOpen_label"),
				message: lang.get("executableOpen_msg"),
				defaultId: 1, // default button
			}).then(({response}) => {
				if (response === 0) {
					return tryOpen()
				} else {
					return Promise.resolve()
				}
			})
		} else {
			return tryOpen()
		}
	}

	async saveBlob(filename: string, data: Uint8Array): Promise<void> {
		const savePath = await this._pickSavePath(filename)
		await this._fs.promises.mkdir(path.dirname(savePath), {recursive: true})
		await this._fs.promises.writeFile(savePath, data)

		// See doc for _lastOpenedFileManagerAt on why we do this throttling.
		const lastOpenedFileManagerAt = this._lastOpenedFileManagerAt
		const fileManagerTimeout = await this._conf.getConst("fileManagerTimeout")
		if (lastOpenedFileManagerAt == null || this._dateProvider.now() - lastOpenedFileManagerAt > fileManagerTimeout) {
			this._lastOpenedFileManagerAt = this._dateProvider.now()
			await this._electron.shell.openPath(path.dirname(savePath))
		}
	}

	async _pickSavePath(filename: string): Promise<string> {
		const defaultDownloadPath = await this._conf.getVar('defaultDownloadPath')
		if (defaultDownloadPath != null) {
			const fileName = path.basename(filename)
			return path.join(
				defaultDownloadPath,
				nonClobberingFilename(
					await this._fs.promises.readdir(defaultDownloadPath),
					fileName
				)
			)
		} else {
			const {canceled, filePath} = await this._electron.dialog.showSaveDialog(null,
				{defaultPath: path.join(this._electron.app.getPath('downloads'), filename)})
			if (canceled) {
				throw new CancelledError("Path selection cancelled")
			} else {
				return assertNotNull(filePath)
			}
		}
	}

	/**
	 * Get a directory under tutanota's temporary directory, will create it if it doesn't exist
	 * @returns {Promise<string>}
	 * @param subdirs
	 */
	async getTutanotaTempDirectory(...subdirs: string[]): Promise<string> {
		const dirPath = this.getTutanotaTempPath(...subdirs)
		await this._fs.promises.mkdir(dirPath, {recursive: true})
		return dirPath
	}

	/**
	 * Get a path to a directory under tutanota's temporary directory. Will not create if it doesn't exist
	 * @param subdirs
	 * @returns {string}
	 */
	getTutanotaTempPath(...subdirs: string[]): string {
		return path.join(this._electron.app.getPath("temp"), this._topLevelDownloadDir, ...subdirs)
	}

	deleteTutanotaTempDirectory() {
		// TODO Flow doesn't know about the options param, we should update it and then remove this downcast
		// Using sync version because this could get called on app shutdown and it may not complete if async
		downcast(this._fs.rmdirSync)(this.getTutanotaTempPath(), {recursive: true})
	}

	async joinFiles(filename: string, files: Array<string>): Promise<string> {
		const downloadDirectory = await this.getTutanotaTempDirectory("download")
		const fileUri = path.join(downloadDirectory, filename)

		const writeStream = this._fs.createWriteStream(fileUri, {autoClose: false})

		for (const infile of files) {
			await new Promise((resolve, reject) => {
				const readStream = this._fs.createReadStream(infile)
				readStream.on('end', resolve)
				readStream.on('error', reject)
				readStream.pipe(writeStream, {end: false})
			})
		}
		// Wait for the write stream to finish
		await new Promise((resolve, reject) => {
			writeStream.end(resolve)
		})
		return fileUri
	}

	async deleteFile(filename: string): Promise<void> {
		return this._fs.promises.unlink(filename)
	}
}