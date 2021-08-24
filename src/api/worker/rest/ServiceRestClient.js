//@flow
import {locator} from "../WorkerLocator"
import {decryptAndMapToInstance, encryptAndMapToLiteral, resolveServiceSessionKey} from "../crypto/CryptoFacade"
import type {HttpMethodEnum} from "../../common/EntityFunctions"
import {MediaType, resolveTypeReference} from "../../common/EntityFunctions"
import {assertWorkerOrNode} from "../../common/Env"
import {downcast, neverNull} from "../../common/utils/Utils"
import {TypeRef} from "../../common/utils/TypeRef";
import type {TypeModel} from "../../common/EntityTypes"

assertWorkerOrNode()

function hasEncryptedValues(requestTypeModel: TypeModel) : boolean {
	return Object.values(requestTypeModel.values).some(v => downcast(v)?.encrypted)
}

export async function _service<T>(service: SysServiceEnum | TutanotaServiceEnum | MonitorServiceEnum | AccountingServiceEnum | StorageServiceEnum,
                                  method: HttpMethodEnum, requestEntity: ?any, responseTypeRef: ?TypeRef<T>, queryParameter: ?Params, sk: ?Aes128Key, extraHeaders?: Params): Promise<?T> {
	const modelForAppAndVersion = await resolveTypeReference((requestEntity) ? requestEntity._type : (responseTypeRef: any))
	let path = `/rest/${modelForAppAndVersion.app.toLowerCase()}/${service}`
	let queryParams = queryParameter != null ? queryParameter : {}
	const headers = Object.assign(locator.login.createAuthHeaders(), extraHeaders)
	headers['v'] = modelForAppAndVersion.version

	let encryptedEntity
	if (requestEntity != null) {
		let requestTypeModel = await resolveTypeReference(requestEntity._type)
		if (requestTypeModel.encrypted && hasEncryptedValues(requestTypeModel) && sk == null) {
			throw new Error("must provide a session key for an encrypted data transfer type!: " + service)
		} else {
			encryptedEntity = await encryptAndMapToLiteral(requestTypeModel, requestEntity, sk)
		}
	}

	const data = await locator.restClient.request(path, method, queryParams, neverNull(headers), encryptedEntity ? JSON.stringify(encryptedEntity) : null, MediaType.Json)
	if (responseTypeRef) {
		let responseTypeModel = await resolveTypeReference(responseTypeRef)
		let instance = JSON.parse(((data: any): string))
		let resolvedSessionKey = await resolveServiceSessionKey(responseTypeModel, instance)
		return decryptAndMapToInstance(responseTypeModel, instance, resolvedSessionKey ? resolvedSessionKey : sk)
	}
}
