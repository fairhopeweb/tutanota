// @flow

import {create} from "../../common/utils/EntityUtils"
import {TypeRef} from "../../common/utils/TypeRef"
import type {TypeModel} from "../../common/EntityTypes"

import type {BlobAccessInfo} from "../sys/BlobAccessInfo"
import type {BlobId} from "../sys/BlobId"

export const FileBlobServiceGetReturnTypeRef: TypeRef<FileBlobServiceGetReturn> = new TypeRef("tutanota", "FileBlobServiceGetReturn")
export const _TypeModel: TypeModel = {
	"name": "FileBlobServiceGetReturn",
	"since": 47,
	"type": "DATA_TRANSFER_TYPE",
	"id": 1195,
	"rootId": "CHR1dGFub3RhAASr",
	"versioned": false,
	"encrypted": false,
	"values": {
		"_format": {
			"id": 1196,
			"type": "Number",
			"cardinality": "One",
			"final": false,
			"encrypted": false
		}
	},
	"associations": {
		"accessInfos": {
			"id": 1198,
			"type": "AGGREGATION",
			"cardinality": "Any",
			"final": false,
			"refType": "BlobAccessInfo",
			"dependency": "sys"
		},
		"blobs": {
			"id": 1197,
			"type": "AGGREGATION",
			"cardinality": "Any",
			"final": false,
			"refType": "BlobId",
			"dependency": "sys"
		}
	},
	"app": "tutanota",
	"version": "47"
}

export function createFileBlobServiceGetReturn(values?: $Shape<$Exact<FileBlobServiceGetReturn>>): FileBlobServiceGetReturn {
	return Object.assign(create(_TypeModel, FileBlobServiceGetReturnTypeRef), values)
}

export type FileBlobServiceGetReturn = {
	_type: TypeRef<FileBlobServiceGetReturn>;

	_format: NumberString;

	accessInfos: BlobAccessInfo[];
	blobs: BlobId[];
}