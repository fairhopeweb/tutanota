// @flow

export const StorageService = Object.freeze({
	BlobService: "blobservice",
	BlobAccessTokenService: "blobaccesstokenservice",
	BlobReferenceService: "blobreferenceservice"
})

export type StorageServiceType = $Values<typeof StorageService>