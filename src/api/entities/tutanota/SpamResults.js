// @flow

import {create} from "../../common/utils/EntityUtils"
import {TypeRef} from "../../common/utils/TypeRef"
import type {TypeModel} from "../../common/EntityTypes"


export const SpamResultsTypeRef: TypeRef<SpamResults> = new TypeRef("tutanota", "SpamResults")
export const _TypeModel: TypeModel = {
	"name": "SpamResults",
	"since": 48,
	"type": "AGGREGATED_TYPE",
	"id": 1219,
	"rootId": "CHR1dGFub3RhAATD",
	"versioned": false,
	"encrypted": false,
	"values": {
		"_id": {
			"id": 1220,
			"type": "CustomId",
			"cardinality": "One",
			"final": true,
			"encrypted": false
		}
	},
	"associations": {
		"list": {
			"id": 1221,
			"type": "LIST_ASSOCIATION",
			"cardinality": "One",
			"final": true,
			"refType": "SpamResult"
		}
	},
	"app": "tutanota",
	"version": "48"
}

export function createSpamResults(values?: $Shape<$Exact<SpamResults>>): SpamResults {
	return Object.assign(create(_TypeModel, SpamResultsTypeRef), values)
}

export type SpamResults = {
	_type: TypeRef<SpamResults>;

	_id: Id;

	list: Id;
}