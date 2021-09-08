// @flow
import type {FileDataDataGet} from "../../entities/tutanota/FileDataDataGet"
import {_TypeModel as FileDataDataGetTypeModel, createFileDataDataGet} from "../../entities/tutanota/FileDataDataGet"
import {addParamsToUrl, isSuspensionResponse, RestClient} from "../rest/RestClient"
import {encryptAndMapToLiteral, encryptBytes, resolveSessionKey} from "../crypto/CryptoFacade"
import {aes128Decrypt} from "../crypto/Aes"
import type {File as TutanotaFile} from "../../entities/tutanota/File"
import {_TypeModel as FileTypeModel} from "../../entities/tutanota/File"
import {_TypeModel as FileDataTypeModel, FileDataTypeRef} from "../../entities/tutanota/FileData"
import {assertNotNull, filterInt, neverNull} from "../../common/utils/Utils"
import type {LoginFacade} from "./LoginFacade"
import {createFileDataDataPost} from "../../entities/tutanota/FileDataDataPost"
import {FileDataReturnPostTypeRef} from "../../entities/tutanota/FileDataReturnPost"
import {GroupType, MAX_BLOB_SIZE_BYTES} from "../../common/TutanotaConstants"
import {random} from "../crypto/Randomizer"
import {_TypeModel as FileDataDataReturnTypeModel} from "../../entities/tutanota/FileDataDataReturn"
import {HttpMethod, MediaType, resolveTypeReference} from "../../common/EntityFunctions"
import {assertWorkerOrNode, getHttpOrigin, Mode} from "../../common/Env"
import {aesDecryptFile, aesEncryptFile} from "../../../native/worker/AesApp"
import {handleRestError} from "../../common/error/RestError"
import type {NativeDownloadResult} from "../../../native/common/FileApp"
import {fileApp} from "../../../native/common/FileApp"
import {convertToDataFile} from "../../common/DataFile"
import type {SuspensionHandler} from "../SuspensionHandler"
import {StorageService} from "../../entities/storage/Services"
import {uint8ArrayToKey} from "../crypto/CryptoUtils"
import {hash} from "../crypto/Sha256"
import type {BlobId} from "../../entities/sys/BlobId"
import {createBlobId} from "../../entities/sys/BlobId"
import {serviceRequest, serviceRequestVoid} from "../EntityWorker"
import {createBlobAccessTokenData} from "../../entities/storage/BlobAccessTokenData"
import {BlobAccessTokenReturnTypeRef} from "../../entities/storage/BlobAccessTokenReturn"
import type {BlobAccessInfo} from "../../entities/sys/BlobAccessInfo"
import {_TypeModel as BlobDataGetTypeModel, createBlobDataGet} from "../../entities/storage/BlobDataGet"
import {createBlobWriteData} from "../../entities/storage/BlobWriteData"
import {createTypeInfo} from "../../entities/sys/TypeInfo"
import {uint8ArrayToBase64} from "../../common/utils/Encoding"
import {TypeRef} from "../../common/utils/TypeRef"
import type {TypeModel} from "../../common/EntityTypes"
import {LoginFacadeImpl} from "./LoginFacade"
import {TutanotaService} from "../../entities/tutanota/Services"
import type {FileBlobServiceGetReturn} from "../../entities/tutanota/FileBlobServiceGetReturn"
import {FileBlobServiceGetReturnTypeRef} from "../../entities/tutanota/FileBlobServiceGetReturn"
import {promiseMap} from "../../common/utils/PromiseUtils"
import {arrayEquals, concat, isEmpty, splitUint8ArrayInChunks} from "../../common/utils/ArrayUtils"
import {FileBlobServicePostReturnTypeRef} from "../../entities/tutanota/FileBlobServicePostReturn"
import {locator} from "../WorkerLocator"
import {createBlobReferenceDataPut} from "../../entities/storage/BlobReferenceDataPut"
import type {TargetServer} from "../../entities/sys/TargetServer"
import {ProgrammingError} from "../../common/error/ProgrammingError"

assertWorkerOrNode()

const REST_PATH = "/rest/tutanota/filedataservice"
const STORAGE_REST_PATH = `/rest/storage/${StorageService.BlobService}`

export class FileFacade {
	_login: LoginFacadeImpl;
	_restClient: RestClient;
	_suspensionHandler: SuspensionHandler;

	constructor(login: LoginFacadeImpl, restClient: RestClient, suspensionHandler: SuspensionHandler) {
		this._login = login
		this._restClient = restClient
		this._suspensionHandler = suspensionHandler
	}

	async downloadFileContent(file: TutanotaFile): Promise<DataFile> {
		const fileDataId = assertNotNull(file.data, "trying to download a TutanotaFile that has no data")
		const fileData = await locator.cachingEntityClient.load(FileDataTypeRef, fileDataId)
		if (!isEmpty(fileData.blocks)) {
			return this.downloadFileBlockContent(file)
		} else if (!isEmpty(fileData.blobs)) {
			return this.downloadFileBlobContent(file)
		} else {
			throw new ProgrammingError("FileData without blobs or blocks")
		}
	}

	async downloadFileBlockContent(file: TutanotaFile): Promise<DataFile> {
		let requestData = createFileDataDataGet()
		requestData.file = file._id
		requestData.base64 = false

		return resolveSessionKey(FileTypeModel, file).then(sessionKey => {
			return encryptAndMapToLiteral(FileDataDataGetTypeModel, requestData, null).then(entityToSend => {
				let headers = this._login.createAuthHeaders()
				headers['v'] = FileDataDataGetTypeModel.version
				let body = JSON.stringify(entityToSend)
				return this._restClient.request(REST_PATH, HttpMethod.GET, {}, headers, body, MediaType.Binary)
				           .then(data => {
					           return convertToDataFile(file, aes128Decrypt(neverNull(sessionKey), data))
				           })
			})
		})
	}


	async downloadFileBlobContent(file: TutanotaFile): Promise<DataFile> {
		let requestData = createFileDataDataGet()
		requestData.file = file._id
		requestData.base64 = false

		const sessionKey = await resolveSessionKey(FileTypeModel, file)
		const serviceReturn = await serviceRequest(TutanotaService.FileBlobService, HttpMethod.GET, requestData, FileBlobServiceGetReturnTypeRef)

		const accessInfos = serviceReturn.accessInfos
		const promises: Array<Promise<Array<{blobId: BlobId, data: Uint8Array}>>> = accessInfos.map(info =>
			promiseMap(info.blobs, async blobId => {
				const data: Uint8Array = await this._downloadRawBlobs(info.storageAccessToken, info.archiveId, blobId.blobId, info.servers)
				return {blobId, data}
			}, {concurrency: 1})
		)

		const promisesResolved: Array<Array<{blobId: BlobId, data: Uint8Array}>> = await Promise.all(promises)
		const blobs: Array<{blobId: BlobId, data: Uint8Array}> = promisesResolved.flat()

		const orderedBlobs: Array<Uint8Array> = serviceReturn.blobs.map(blobId =>
			blobs.find(blob => arrayEquals(blob.blobId.blobId, blobId.blobId))?.data ?? new Uint8Array(0)
		)
		const data = concat(...orderedBlobs)
		return convertToDataFile(file, aes128Decrypt(neverNull(sessionKey), data))
	}

	async downloadFileContentNative(file: TutanotaFile): Promise<FileReference> {
		const fileDataId = assertNotNull(file.data, "trying to download a TutanotaFile that has no data")
		const fileData = await locator.cachingEntityClient.load(FileDataTypeRef, fileDataId)
		if (!isEmpty(fileData.blocks)) {
			return this.downloadFileNative(file, file => this.fileBlockDownloader(file));
		} else if (!isEmpty(fileData.blobs)) {
			return this.downloadFileNative(file, file => this.fileBlobDownloader(file));
		} else {
			throw new ProgrammingError("FileData without blobs or blocks")
		}
	}

	async downloadFileNative(file: TutanotaFile, fileDownloader: (TutanotaFile) => Promise<NativeDownloadResult>): Promise<FileReference> {
		if (![Mode.App, Mode.Desktop].includes(env.mode)) {
			return Promise.reject("Environment is not app or Desktop!")
		}

		if (this._suspensionHandler.isSuspended()) {
			return this._suspensionHandler.deferRequest(() => this.downloadFileNative(file, fileDownloader))
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

			} else if (suspensionTime && isSuspensionResponse(statusCode, suspensionTime)) {
				this._suspensionHandler.activateSuspensionIfInactive(Number(suspensionTime))
				return this._suspensionHandler.deferRequest(() => fileDownloader(file))
			} else {
				throw handleRestError(statusCode, ` | GET failed to natively download attachment`, errorId, precondition)
			}
		} finally {
			if (encryptedFileUri != null) {
				try {
					await fileApp.deleteFile(encryptedFileUri)
				} catch {
					console.log("Failed to delete encrypted file", encryptedFileUri)
				}
			}
		}
	}

	getFileRequestData(file: TutanotaFile): FileDataDataGet {
		let requestData = createFileDataDataGet()
		requestData.file = file._id
		requestData.base64 = false
		return requestData
	}

	async fileBlockDownloader(file: TutanotaFile): Promise<NativeDownloadResult> {
		const entityToSend = await encryptAndMapToLiteral(FileDataDataGetTypeModel, this.getFileRequestData(file), null)

		let headers = this._login.createAuthHeaders()
		headers['v'] = BlobDataGetTypeModel.version
		let body = JSON.stringify(entityToSend)
		let queryParams = {'_body': body}
		let url = addParamsToUrl(new URL(getHttpOrigin() + REST_PATH), queryParams)

		return fileApp.download(url.toString(), file.name, headers)
	}


	async fileBlobDownloader(file: TutanotaFile): Promise<NativeDownloadResult> {
		const serviceReturn: FileBlobServiceGetReturn = await serviceRequest(
			TutanotaService.FileBlobService,
			HttpMethod.GET,
			this.getFileRequestData(file),
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

		let headers = this._login.createAuthHeaders()
		headers['v'] = BlobDataGetTypeModel.version
		return fileApp.downloadBlobs(file.name, headers, orderedBlobInfos)
	}

	uploadFileData(dataFile: DataFile, sessionKey: Aes128Key): Promise<Id> {
		let encryptedData = encryptBytes(sessionKey, dataFile.data)
		let fileData = createFileDataDataPost()
		fileData.size = dataFile.data.byteLength.toString()
		fileData.group = this._login.getGroupId(GroupType.Mail) // currently only used for attachments
		return serviceRequest(TutanotaService.FileDataService, HttpMethod.POST, fileData, FileDataReturnPostTypeRef, null, sessionKey)
			.then(fileDataPostReturn => {
				// upload the file content
				let fileDataId = fileDataPostReturn.fileData
				let headers = this._login.createAuthHeaders()
				headers['v'] = FileDataDataReturnTypeModel.version
				return this._restClient.request(REST_PATH, HttpMethod.PUT,
					{fileDataId: fileDataId}, headers, encryptedData, MediaType.Binary)
				           .then(() => fileDataId)
			})
	}


	async uploadFileBlobData(dataFile: DataFile, sessionKey: Aes128Key): Promise<Id> {
		let encryptedData = encryptBytes(sessionKey, dataFile.data)
		let postData = createFileDataDataPost()
		postData.size = dataFile.data.byteLength.toString()
		postData.group = this._login.getGroupId(GroupType.Mail) // currently only used for attachments
		const fileBlobServicePostReturn = await serviceRequest(TutanotaService.FileBlobService, HttpMethod.POST, postData, FileBlobServicePostReturnTypeRef, null, sessionKey)
		const fileData = await locator.cachingEntityClient.load(FileDataTypeRef, fileBlobServicePostReturn.fileData)

		// TODO: Watch for timeout of the access token when uploading many chunks
		const {storageAccessToken, servers} = fileBlobServicePostReturn.accessInfo
		const headers = Object.assign({
			storageAccessToken,
			'v': BlobDataGetTypeModel.version
		}, this._login.createAuthHeaders())

		const chunks = splitUint8ArrayInChunks(MAX_BLOB_SIZE_BYTES, encryptedData)
		for (let chunk of chunks) {
			const blobId = uint8ArrayToBase64(hash(chunk).slice(0, 6))
			const blobReferenceToken = await this._restClient.request(STORAGE_REST_PATH, HttpMethod.PUT, {blobId}, headers, chunk,
				MediaType.Binary, null, servers[0].url)

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
	 * Does not cleanup uploaded files. This is a responsibility of the caller
	 */
	async uploadFileDataNative(fileReference: FileReference, sessionKey: Aes128Key): Promise<Id> {
		if (this._suspensionHandler.isSuspended()) {
			return this._suspensionHandler.deferRequest(() => this.uploadFileDataNative(fileReference, sessionKey))
		}
		const encryptedFileInfo = await aesEncryptFile(sessionKey, fileReference.location, random.generateRandomData(16))
		const fileData = createFileDataDataPost()
		fileData.size = encryptedFileInfo.unencSize.toString()
		fileData.group = this._login.getGroupId(GroupType.Mail)


		const fileDataPostReturn = await serviceRequest(TutanotaService.FileDataService, HttpMethod.POST, fileData, FileDataReturnPostTypeRef, null, sessionKey)
		const fileDataId = fileDataPostReturn.fileData

		const headers = this._login.createAuthHeaders()
		headers['v'] = FileDataDataReturnTypeModel.version

		const url = addParamsToUrl(new URL(REST_PATH, getHttpOrigin()), {fileDataId})
		const {
			statusCode,
			uri,
			errorId,
			precondition,
			suspensionTime
		} = await fileApp.upload(encryptedFileInfo.uri, url.toString(), headers)

		if (statusCode === 200) {
			return fileDataId;
		} else if (suspensionTime && isSuspensionResponse(statusCode, suspensionTime)) {
			this._suspensionHandler.activateSuspensionIfInactive(Number(suspensionTime))
			return this._suspensionHandler.deferRequest(() => this.uploadFileDataNative(fileReference, sessionKey))
		} else {
			throw handleRestError(statusCode, ` | PUT ${url.toString()} failed to natively upload attachment`, errorId, precondition)
		}
	}

	/**
	 * @returns blobReferenceToken
	 */
	async uploadBlob(instance: {_type: TypeRef<any>}, blobData: Uint8Array, ownerGroupId: Id): Promise<Uint8Array> {
		const typeModel = await resolveTypeReference(instance._type)
		const {storageAccessToken, servers} = await this.getUploadToken(typeModel, ownerGroupId)

		const sessionKey = neverNull(await resolveSessionKey(typeModel, instance))
		const encryptedData = encryptBytes(sessionKey, blobData)
		const blobId = uint8ArrayToBase64(hash(encryptedData).slice(0, 6))

		const headers = Object.assign({
			storageAccessToken,
			'v': BlobDataGetTypeModel.version
		}, this._login.createAuthHeaders())
		return this._restClient.request(STORAGE_REST_PATH, HttpMethod.PUT, {blobId}, headers, encryptedData,
			MediaType.Binary, null, servers[0].url)
	}

	async downloadBlob(archiveId: Id, blobId: Uint8Array, key: Uint8Array): Promise<Uint8Array> {
		const {storageAccessToken, servers} = await this.getDownloadToken(archiveId)
		const data = await this._downloadRawBlobs(storageAccessToken, archiveId, blobId, servers)
		return aes128Decrypt(uint8ArrayToKey(key), data)
	}

	async _downloadRawBlobs(storageAccessToken: string, archiveId: Id, blobId: Uint8Array, servers: Array<TargetServer>): Promise<Uint8Array> {
		const headers = Object.assign({
			storageAccessToken,
			'v': BlobDataGetTypeModel.version
		}, this._login.createAuthHeaders())
		const getData = createBlobDataGet({
			archiveId,
			blobId: createBlobId({blobId})
		})
		const literalGetData = await encryptAndMapToLiteral(BlobDataGetTypeModel, getData, null)
		const body = JSON.stringify(literalGetData)
		return await this._restClient.request(STORAGE_REST_PATH, HttpMethod.GET, {},
			headers, body, MediaType.Binary, null, servers[0].url)
	}

	async getUploadToken(typeModel: TypeModel, ownerGroupId: Id): Promise<BlobAccessInfo> {
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

	async getDownloadToken(readArchiveId: Id): Promise<BlobAccessInfo> {
		const tokenRequest = createBlobAccessTokenData({
			readArchiveId
		})
		const {blobAccessInfo} = await serviceRequest(StorageService.BlobAccessTokenService, HttpMethod.POST, tokenRequest, BlobAccessTokenReturnTypeRef)
		return blobAccessInfo
	}
}
