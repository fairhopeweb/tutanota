// @flow
import type {FileDataDataGet} from "../../entities/tutanota/FileDataDataGet"
import {_TypeModel as FileDataDataGetTypeModel, createFileDataDataGet} from "../../entities/tutanota/FileDataDataGet"
import {_TypeModel as FileDataDataReturnTypeModel} from "../../entities/tutanota/FileDataDataReturn"
import {addParamsToUrl, isSuspensionResponse, RestClient} from "../rest/RestClient"
import {encryptAndMapToLiteral, encryptBytes, resolveSessionKey} from "../crypto/CryptoFacade"
import {aes128Decrypt} from "../crypto/Aes"
import type {File as TutanotaFile} from "../../entities/tutanota/File"
import {_TypeModel as FileTypeModel} from "../../entities/tutanota/File"
import {_TypeModel as FileDataTypeModel, FileDataTypeRef} from "../../entities/tutanota/FileData"
import {assertNotNull, filterInt, neverNull} from "../../common/utils/Utils"
import type {LoginFacade} from "./LoginFacade"
import {createFileDataDataPost} from "../../entities/tutanota/FileDataDataPost"
import {GroupType, MAX_BLOB_SIZE_BYTES} from "../../common/TutanotaConstants"
import {random} from "../crypto/Randomizer"
import {HttpMethod, MediaType, resolveTypeReference} from "../../common/EntityFunctions"
import {assertWorkerOrNode, getHttpOrigin, isApp, isDesktop} from "../../common/Env"
import {aesDecryptFile, aesEncryptFile} from "../../../native/worker/AesApp"
import {handleRestError, PreconditionFailedError} from "../../common/error/RestError"
import type {NativeDownloadResult} from "../../../native/common/FileApp"
import {fileApp, uriToFileRef} from "../../../native/common/FileApp"
import {convertToDataFile} from "../../common/DataFile"
import type {SuspensionHandler} from "../SuspensionHandler"
import {StorageService} from "../../entities/storage/Services"
import {uint8ArrayToKey} from "../crypto/CryptoUtils"
import {hash} from "../crypto/Sha256"
import type {BlobId} from "../../entities/sys/BlobId"
import {serviceRequest, serviceRequestVoid} from "../EntityWorker"
import {createBlobAccessTokenData} from "../../entities/storage/BlobAccessTokenData"
import {BlobAccessTokenReturnTypeRef} from "../../entities/storage/BlobAccessTokenReturn"
import type {BlobAccessInfo} from "../../entities/sys/BlobAccessInfo"
import {_TypeModel as BlobDataGetTypeModel, createBlobDataGet} from "../../entities/storage/BlobDataGet"
import {createBlobWriteData} from "../../entities/storage/BlobWriteData"
import {createTypeInfo} from "../../entities/sys/TypeInfo"
import {uint8ArrayToBase64, uint8ArrayToHex} from "../../common/utils/Encoding"
import {TypeRef} from "../../common/utils/TypeRef"
import type {TypeModel} from "../../common/EntityTypes"
import {LoginFacadeImpl} from "./LoginFacade"
import {TutanotaService} from "../../entities/tutanota/Services"
import type {FileBlobServiceGetReturn} from "../../entities/tutanota/FileBlobServiceGetReturn"
import {FileBlobServiceGetReturnTypeRef} from "../../entities/tutanota/FileBlobServiceGetReturn"
import {arrayEquals, concat, isEmpty, splitUint8ArrayInChunks} from "../../common/utils/ArrayUtils"
import {FileBlobServicePostReturnTypeRef} from "../../entities/tutanota/FileBlobServicePostReturn"
import {locator} from "../WorkerLocator"
import {createBlobReferenceDataPut} from "../../entities/storage/BlobReferenceDataPut"
import type {TargetServer} from "../../entities/sys/TargetServer"
import {ProgrammingError} from "../../common/error/ProgrammingError"
import {getRestPath} from "../../entities/ServiceUtils"
import {promiseMap} from "../../common/utils/PromiseUtils"
import {FileDataReturnPostTypeRef} from "../../entities/tutanota/FileDataReturnPost"

assertWorkerOrNode()


type BlobDownloader<T> = (blobId: BlobId, headers: Params, body: string, server: TargetServer) => Promise<T>

export type BlobUploadData<T: Uint8Array | FileReference> = {
	blobId: string,
	data: T
}

type FileEncryptor<T : Uint8Array | FileReference> = (Aes128Key, T) => Promise<T>

type BlobSplitter<T: Uint8Array | FileReference> = (data: T) => Promise<Array<BlobUploadData<T>>>

type BlobUploader<T: Uint8Array | FileReference> = (url: string, headers: Params, blobId: string, data: T) => Promise<Uint8Array>


function _getBlobIdFromData(blob: Uint8Array): string {
	return uint8ArrayToBase64(hash(blob).slice(0, 6))
}

export class FileFacade {
	_login: LoginFacadeImpl;
	_restClient: RestClient;
	_suspensionHandler: SuspensionHandler;

	constructor(login: LoginFacadeImpl, restClient: RestClient, suspensionHandler: SuspensionHandler) {
		this._login = login
		this._restClient = restClient
		this._suspensionHandler = suspensionHandler
	}

	/**
	 * Download and decrypt a single blob.
	 */
	async downloadBlob(archiveId: Id, blobId: BlobId, key: Uint8Array): Promise<Uint8Array> {
		const {storageAccessToken, servers} = await this._getDownloadToken(archiveId)
		const data = await this._downloadRawBlob(storageAccessToken, archiveId, blobId, servers, this._blobDownloaderWeb.bind(this))
		return aes128Decrypt(uint8ArrayToKey(key), data)
	}

	/**
	 * Download a file and return the data itself.
	 */
	async downloadFileContent(file: TutanotaFile): Promise<DataFile> {
		const blockDownloader = (file) => this._downloadFileDataBlock(file)
		const blobDownloader = (file) => this._downloadFileDataBlob(file)
		const data = await this._downloadFileWithDownloader(file, blockDownloader, blobDownloader)

		const sessionKey = await resolveSessionKey(FileTypeModel, file)
		return convertToDataFile(file, aes128Decrypt(neverNull(sessionKey), data))
	}

	/**
	 * Download with native downloader and return only a FileReference. Useful when we don't want to pass all the data through the native bridge.
	 */
	async downloadFileContentNative(file: TutanotaFile): Promise<FileReference> {
		const blockDownloader = (file) => this._downloadFileNative(file, file => this._downloadFileDataBlockNative(file))
		const blobDownloader = (file) => this._downloadFileNative(file, file => this._downloadFileDataBlobNative(file));
		return this._downloadFileWithDownloader(file, blockDownloader, blobDownloader)
	}

	/**
	 * Download a TutanotaFile to either a FileReference (on native) or a DataFile
	 * Takes two functions that do the actual download depending on whether this TutanotaFile is saved as blobs (new BlobStorage) or blocks (old Database)
	 */
	async _downloadFileWithDownloader<T>(file: TutanotaFile, blockDownloader: (TutanotaFile) => Promise<T>, blobDownloader: (TutanotaFile) => Promise<T>): Promise<T> {
		const fileDataId = assertNotNull(file.data, "trying to download a TutanotaFile that has no data")
		const fileData = await locator.cachingEntityClient.load(FileDataTypeRef, fileDataId)

		if (!isEmpty(fileData.blocks)) {
			return blockDownloader(file)
		} else if (!isEmpty(fileData.blobs)) {
			return blobDownloader(file);
		} else {
			throw new ProgrammingError("FileData without blobs or blocks")
		}
	}

	/**
	 * Download the data for a TutanotaFile from Blocks (in Database)
	 * @return Uint8Array actual file data
	 */
	async _downloadFileDataBlock(file: TutanotaFile): Promise<Uint8Array> {
		const entityToSend = await encryptAndMapToLiteral(FileDataDataGetTypeModel, this._getFileRequestData(file), null)
		const body = JSON.stringify(entityToSend)
		const headers = this._login.createAuthHeaders()

		headers['v'] = FileDataDataGetTypeModel.version
		return this._restClient.request(getRestPath(TutanotaService.FileDataService), HttpMethod.GET, {}, headers, body, MediaType.Binary)
	}

	/**
	 * Download the data for a TutanotaFile from Blocks (in Database) on native
	 * @return NativeDownloadResult which contains a uri that points to the downloaded and decrypted file
	 */
	async _downloadFileDataBlockNative(file: TutanotaFile): Promise<NativeDownloadResult> {
		const entityToSend = await encryptAndMapToLiteral(FileDataDataGetTypeModel, this._getFileRequestData(file), null)
		const body = JSON.stringify(entityToSend)
		let headers = this._login.createAuthHeaders()

		headers['v'] = FileDataDataGetTypeModel.version
		let queryParams = {'_body': body}
		let url = addParamsToUrl(new URL(getRestPath(TutanotaService.FileDataService), getHttpOrigin()), queryParams)
		return fileApp.download(url.toString(), headers, file.name)
	}

	/**
	 * Downloads the data for a TutanotaFile from the BlobStorage
	 * @param file
	 * @returns {Promise<Uint8Array>} A Promise to the actual encrypted data
	 * @private
	 */
	async _downloadFileDataBlob(file: TutanotaFile): Promise<Uint8Array> {
		const blobs: Array<Uint8Array> = await this._downloadBlobsOfFile(
			file,
			(blobId: BlobId, headers: Params, body: string, server: TargetServer) =>
				this._blobDownloaderWeb(blobId, headers, body, server)
		)
		return concat(...blobs)
	}

	/**
	 * Downloads the data of a TutanotaFile from blobs using native routines
	 * @param file
	 * @returns {Promise<NativeDownloadResult>} A promise containing the result of the download and a uri pointing to the actual encrypted file in the filesystem
	 * @private
	 */
	async _downloadFileDataBlobNative(file: TutanotaFile): Promise<NativeDownloadResult> {
		const blobs: Array<NativeDownloadResult> = await this._downloadBlobsOfFile(
			file,
			(blobId: BlobId, headers: Params, body: string, server: TargetServer) =>
				this._blobDownloaderNative(blobId, headers, body, server)
		)

		// TODO:
		// make sure all suspensions have been handled

		// Return first error code
		const firstError = blobs.find(result => result.statusCode !== 200)
		if (firstError) {
			return firstError
		}

		// now blobs has the correct order of downloaded blobs, and we need to tell native to join them
		const files = blobs.map(r => assertNotNull(r.encryptedFileUri))

		const encryptedFileUri = await fileApp.joinFiles(file.name, files)
		for (const tmpBlobFile of files) {
			fileApp.deleteFile(tmpBlobFile)
		}

		return {
			statusCode: 200,
			encryptedFileUri
		}
	}

	async _downloadBlobsOfFile<T>(file: TutanotaFile, downloader: BlobDownloader<T>): Promise<Array<T>> {
		const serviceReturn: FileBlobServiceGetReturn = await serviceRequest(
			TutanotaService.FileBlobService,
			HttpMethod.GET,
			this._getFileRequestData(file),
			FileBlobServiceGetReturnTypeRef
		)

		const accessInfos = serviceReturn.accessInfos
		const orderedBlobInfos: Array<{blobId: BlobId, accessInfo: BlobAccessInfo}> = serviceReturn.blobs.map(blobId => {
				const accessInfo = assertNotNull(
					accessInfos.find(info => info.blobs.find(b => arrayEquals(b.blobId, blobId.blobId))),
					"Missing accessInfo for blob"
				)
				return {blobId, accessInfo}
			}
		)

		return promiseMap(orderedBlobInfos, ({blobId, accessInfo}) => {
			return this._downloadRawBlob(accessInfo.storageAccessToken, accessInfo.archiveId, blobId, accessInfo.servers, downloader)
		}, {concurrency: 1})
	}

	/**
	 * Downloads the data of a TutanotaFile with a supplied downloader function (for blobs or blocks)
	 * Takes care of suspension handling and decryption of the data
	 * @param fileDownloader Function used to download the encrypted file contents to the filesystem (from either blobs or blocks)
	 * @returns {Promise<FileReference>} A promise containing a uri pointing to the decrypted file in the filesystem
	 * @private
	 */
	async _downloadFileNative(file: TutanotaFile, fileDownloader: (TutanotaFile) => Promise<NativeDownloadResult>): Promise<FileReference> {
		if (!isApp() && !isDesktop()) {
			return Promise.reject("Environment is not app or Desktop!")
		}

		if (this._suspensionHandler.isSuspended()) {
			return this._suspensionHandler.deferRequest(() => this._downloadFileNative(file, fileDownloader))
		}

		const sessionKey = await resolveSessionKey(FileTypeModel, file)
		const {
			statusCode,
			encryptedFileUri,
			errorId,
			precondition,
			suspensionTime
		} = await fileDownloader(file)


		try {
			if (statusCode === 200 && encryptedFileUri != null) {
				const decryptedFileUrl = await aesDecryptFile(neverNull(sessionKey), encryptedFileUri)

				const mimeType = file.mimeType == null ? MediaType.Binary : file.mimeType
				return {
					_type: 'FileReference',
					name: file.name,
					mimeType,
					location: decryptedFileUrl,
					size: filterInt(file.size)
				}

			} else if (isSuspensionResponse(statusCode, suspensionTime)) {
				this._suspensionHandler.activateSuspensionIfInactive(Number(suspensionTime))
				return this._suspensionHandler.deferRequest(() => this._downloadFileNative(file, fileDownloader))
			} else {
				throw handleRestError(statusCode, ` | GET failed to natively download attachment`, errorId, precondition)
			}
		} catch {
			if (encryptedFileUri != null) {
				try {
					await fileApp.deleteFile(encryptedFileUri)
				} catch {
					console.log("Failed to delete encrypted file", encryptedFileUri)
				}
			}
			// TODO better error handling here
			throw new Error("Failed to download file")
		}
	}

	_getFileRequestData(file: TutanotaFile): FileDataDataGet {
		let requestData = createFileDataDataGet()
		requestData.file = file._id
		requestData.base64 = false
		return requestData
	}

	async _downloadRawBlob<T>(storageAccessToken: string, archiveId: Id, blobId: BlobId, servers: Array<TargetServer>, blobDownloader: BlobDownloader<T>): Promise<T> {
		const headers = Object.assign({
			storageAccessToken,
			'v': BlobDataGetTypeModel.version
		}, this._login.createAuthHeaders())
		const getData = createBlobDataGet({
			archiveId,
			blobId
		})
		const literalGetData = await encryptAndMapToLiteral(BlobDataGetTypeModel, getData, null)
		const body = JSON.stringify(literalGetData)
		const server = servers[0] // TODO: Use another server if download fails

		return blobDownloader(blobId, headers, body, server)
	}

	async _blobDownloaderWeb(blobId: BlobId, headers: Params, body: string, server: TargetServer): Promise<Uint8Array> {
		return this._restClient.request(getRestPath(StorageService.BlobService), HttpMethod.GET, {},
			headers, body, MediaType.Binary, null, server.url)
	}

	async _blobDownloaderNative(blobId: BlobId, headers: Params, body: string, server: TargetServer): Promise<NativeDownloadResult> {
		const filename = uint8ArrayToHex(blobId.blobId) + ".blob"
		const serviceUrl = new URL(getRestPath(StorageService.BlobService), server.url)
		const url = addParamsToUrl(serviceUrl, {"_body": body})
		return fileApp.download(url.toString(), headers, filename)
	}

	async _getDownloadToken(readArchiveId: Id): Promise<BlobAccessInfo> {
		const tokenRequest = createBlobAccessTokenData({
			readArchiveId
		})
		const {blobAccessInfo} = await serviceRequest(StorageService.BlobAccessTokenService, HttpMethod.POST, tokenRequest, BlobAccessTokenReturnTypeRef)
		return blobAccessInfo
	}

	// ↑↑↑ Download ↑↑↑
	//////////////////////////////////////////////////
	// ↓↓↓ Upload ↓↓↓

	async uploadFile(file: DataFile | FileReference, sessionKey: Aes128Key): Promise<Id> {
		switch (file._type) {
			case "DataFile":
				// user added attachment on the web
				return this._handleMigration(() => this._uploadFileBlockData(file, sessionKey), () => this._uploadFileBlobData(file, sessionKey))
			case "FileReference":
				// "usually" attaching a file on a native implementation
				return this._handleMigration(() => this._uploadFileBlockDataNative(file, sessionKey), () => this._uploadFileBlobDataNative(file, sessionKey))
			default:
				throw new ProgrammingError("Can only upload DataFile or FileReference")
		}
	}

	// Migrate to blobs when PreconditionFailedError returned by the server
	async _handleMigration(
		blockFunction: () => Promise<Id>,
		blobFunction: () => Promise<Id>
	): Promise<Id> {
		try {
			return await blockFunction()
		} catch (e) {
			if (e instanceof PreconditionFailedError && e.data === "storage.blob_migrate_enabled") {
				return await blobFunction()
			} else {
				throw e
			}
		}
	}

	async _uploadFileBlobData(file: DataFile, sessionKey: Aes128Key): Promise<Id> {
		const encryptor: FileEncryptor<Uint8Array> = async (key, data: Uint8Array) => encryptBytes(key, data)

		const splitter: BlobSplitter<Uint8Array> = async data => splitUint8ArrayInChunks(MAX_BLOB_SIZE_BYTES, data).map((blob: Uint8Array) => ({
			blobId: _getBlobIdFromData(blob),
			data: blob
		}))

		const uploader: BlobUploader<Uint8Array> = (url, headers, blobId, data) =>
			this._restClient.request(getRestPath(StorageService.BlobService), HttpMethod.PUT, {blobId}, headers, data, MediaType.Binary, null, url)

		return this._uploadFileBlobDataWithUploader(file.data, file.data.byteLength, sessionKey, encryptor, splitter, uploader)
	}

	async _uploadFileBlobDataNative(file: FileReference, sessionKey: Aes128Key): Promise<Id> {
		const encryptor: FileEncryptor<FileReference> = async (key, fileReference) => {
			const {uri} = await aesEncryptFile(key, fileReference.location, random.generateRandomData(16))
			return uriToFileRef(uri)
		}

		const splitter: BlobSplitter<FileReference> = async (data: FileReference) => fileApp.splitFileIntoBlobs(data)

		const uploader: BlobUploader<FileReference> = async (url: string, headers: Params, blobId: string, data: FileReference) => {
			const serviceUrl = new URL(getRestPath(StorageService.BlobService), url)
			const fullUrl = addParamsToUrl(serviceUrl, {blobId})

			const {
				suspensionTime,
				responseBody,
				statusCode,
				errorId,
				precondition
			} = await fileApp.upload(data.location, fullUrl.toString(), headers) // blobReferenceToken in the response body

			if (statusCode === 200) {
				return responseBody;
			} else if (isSuspensionResponse(statusCode, suspensionTime)) {
				this._suspensionHandler.activateSuspensionIfInactive(Number(suspensionTime))
				return this._suspensionHandler.deferRequest(() => uploader(url, headers, blobId, data))
			} else {
				throw handleRestError(statusCode, ` | PUT ${url.toString()} failed to natively upload blob`, errorId, precondition)
			}
		}

		return this._uploadFileBlobDataWithUploader(file, file.size, sessionKey, encryptor, splitter, uploader)
	}

	async _uploadFileBlobDataWithUploader<T : FileReference | Uint8Array>(data: T, size: number, sessionKey: Aes128Key, encrypter: FileEncryptor<T>, splitter: BlobSplitter<T>, uploader: BlobUploader<T>): Promise<Id> {
		const encrypted = await encrypter(sessionKey, data)

		const postData = createFileDataDataPost()
		postData.size = size.toString()
		postData.group = this._login.getGroupId(GroupType.Mail) // currently only used for attachments

		const fileBlobServicePostReturn = await serviceRequest(TutanotaService.FileBlobService, HttpMethod.POST, postData, FileBlobServicePostReturnTypeRef, null, sessionKey)
		const fileData = await locator.cachingEntityClient.load(FileDataTypeRef, fileBlobServicePostReturn.fileData)

		// TODO: Watch for timeout of the access token when uploading many chunks
		const {storageAccessToken, servers} = fileBlobServicePostReturn.accessInfo
		const headers = Object.assign({
			storageAccessToken,
			'v': BlobDataGetTypeModel.version
		}, this._login.createAuthHeaders())

		const blobs = await splitter(encrypted)
		for (const {blobId, data} of blobs) {
			const blobReferenceToken = await uploader(servers[0].url, headers, blobId, data)

			const blobReferenceDataPut = createBlobReferenceDataPut({
				blobReferenceToken,
				type: createTypeInfo({application: FileDataTypeModel.app, typeId: String(FileDataTypeModel.id)}),
				instanceElementId: fileData._id
			})
			await serviceRequestVoid(StorageService.BlobReferenceService, HttpMethod.PUT, blobReferenceDataPut)
		}
		return fileData._id
	}

	/**
	 * @returns blobReferenceToken
	 */
	async uploadBlob(instance: {_type: TypeRef<any>}, blobData: Uint8Array, ownerGroupId: Id): Promise<Uint8Array> {
		const typeModel = await resolveTypeReference(instance._type)
		const {storageAccessToken, servers} = await this._getUploadToken(typeModel, ownerGroupId)

		const sessionKey = neverNull(await resolveSessionKey(typeModel, instance))
		const encryptedData = encryptBytes(sessionKey, blobData)
		const blobId = _getBlobIdFromData(encryptedData)

		const headers = Object.assign({
			storageAccessToken,
			'v': BlobDataGetTypeModel.version
		}, this._login.createAuthHeaders())
		return this._restClient.request(getRestPath(StorageService.BlobService), HttpMethod.PUT, {blobId}, headers, encryptedData,
			MediaType.Binary, null, servers[0].url)
	}


	async _getUploadToken(typeModel: TypeModel, ownerGroupId: Id): Promise<BlobAccessInfo> {
		const tokenRequest = createBlobAccessTokenData({
			write: createBlobWriteData({
				type: createTypeInfo({
					application: typeModel.app,
					typeId: String(typeModel.id)
				}),
				archiveOwnerGroup: ownerGroupId,
			})
		})
		const {blobAccessInfo} = await serviceRequest(StorageService.BlobAccessTokenService, HttpMethod.POST, tokenRequest, BlobAccessTokenReturnTypeRef)
		return blobAccessInfo
	}


	/**
	 * Does not cleanup uploaded files. This is a responsibility of the caller
	 */
	async _uploadFileBlockDataNative(fileReference: FileReference, sessionKey: Aes128Key): Promise<Id> {
		if (this._suspensionHandler.isSuspended()) {
			return this._suspensionHandler.deferRequest(() => this._uploadFileBlockDataNative(fileReference, sessionKey))
		}
		const encryptedFileInfo = await aesEncryptFile(sessionKey, fileReference.location, random.generateRandomData(16))
		const fileData = createFileDataDataPost()
		fileData.size = encryptedFileInfo.unencSize.toString()
		fileData.group = this._login.getGroupId(GroupType.Mail)


		const fileDataPostReturn = await serviceRequest(TutanotaService.FileDataService, HttpMethod.POST, fileData, FileDataReturnPostTypeRef, null, sessionKey)
		const fileDataId = fileDataPostReturn.fileData

		const headers = this._login.createAuthHeaders()
		headers['v'] = FileDataDataReturnTypeModel.version

		const url = addParamsToUrl(new URL(getRestPath(TutanotaService.FileDataService), getHttpOrigin()), {fileDataId})
		const {
			statusCode,
			errorId,
			precondition,
			suspensionTime,
		} = await fileApp.upload(encryptedFileInfo.uri, url.toString(), headers)

		if (statusCode === 200) {
			return fileDataId;
		} else if (isSuspensionResponse(statusCode, suspensionTime)) {
			this._suspensionHandler.activateSuspensionIfInactive(Number(suspensionTime))
			return this._suspensionHandler.deferRequest(() => this._uploadFileBlockDataNative(fileReference, sessionKey))
		} else {
			throw handleRestError(statusCode, ` | PUT ${url.toString()} failed to natively upload attachment`, errorId, precondition)
		}
	}

	async _uploadFileBlockData(dataFile: DataFile, sessionKey: Aes128Key): Promise<Id> {
		let encryptedData = encryptBytes(sessionKey, dataFile.data)
		let fileData = createFileDataDataPost()
		fileData.size = dataFile.data.byteLength.toString()
		fileData.group = this._login.getGroupId(GroupType.Mail) // currently only used for attachments
		let fileDataPostReturn = await serviceRequest(TutanotaService.FileDataService, HttpMethod.POST, fileData, FileDataReturnPostTypeRef, null, sessionKey)
		let fileDataId = fileDataPostReturn.fileData
		let headers = this._login.createAuthHeaders()
		headers['v'] = FileDataDataReturnTypeModel.version
		await this._restClient.request(getRestPath(TutanotaService.FileDataService), HttpMethod.PUT,
			{fileDataId: fileDataId}, headers, encryptedData, MediaType.Binary)
		return fileDataId
	}
}
