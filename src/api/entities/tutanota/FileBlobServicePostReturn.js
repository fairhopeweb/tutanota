// @flow

import {create} from "../../common/utils/EntityUtils"
import {TypeRef} from "../../common/utils/TypeRef"
import type {TypeModel} from "../../common/EntityTypes"

import type {BlobAccessInfo} from "../sys/BlobAccessInfo"

export const FileBlobServicePostReturnTypeRef: TypeRef<FileBlobServicePostReturn> = new TypeRef("tutanota", "FileBlobServicePostReturn")
export const _TypeModel: TypeModel = {
	"name": "FileBlobServicePostReturn",
	"since": 47,
	"type": "DATA_TRANSFER_TYPE",
	"id": 1199,
	"rootId": "CHR1dGFub3RhAASv",
	"versioned": false,
	"encrypted": true,
	"values": {
		"_format": {
			"id": 1200,
			"type": "Number",
			"cardinality": "One",
			"final": false,
			"encrypted": false
		}
	},
	"associations": {
		"accessInfo": {
			"id": 1202,
			"type": "AGGREGATION",
			"cardinality": "One",
			"final": false,
			"refType": "BlobAccessInfo",
			"dependency": "sys"
		},
		"fileData": {
			"id": 1201,
			"type": "ELEMENT_ASSOCIATION",
			"cardinality": "One",
			"final": false,
			"refType": "FileData"
		}
	},
	"app": "tutanota",
	"version": "47"
}

export function createFileBlobServicePostReturn(values?: $Shape<$Exact<FileBlobServicePostReturn>>): FileBlobServicePostReturn {
	return Object.assign(create(_TypeModel, FileBlobServicePostReturnTypeRef), values)
}

export type FileBlobServicePostReturn = {
	_type: TypeRef<FileBlobServicePostReturn>;
	_errors: Object;

	_format: NumberString;

	accessInfo: BlobAccessInfo;
	fileData: Id;
}