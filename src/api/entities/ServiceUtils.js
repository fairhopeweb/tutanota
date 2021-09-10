// @flow

import type {MonitorServiceType} from "./monitor/Services"
import {MonitorService} from "./monitor/Services"
import type {AccountingServiceType} from "./accounting/Services"
import type {BaseServiceType} from "./base/Services"
import type {GossipServiceType} from "./gossip/Services"
import type {StorageServiceType} from "./storage/Services"
import type {SysServiceType} from "./sys/Services"
import type {TutanotaServiceType} from "./tutanota/Services"
import {AccountingService} from "./accounting/Services"
import {BaseService} from "./base/Services"
import {GossipService} from "./gossip/Services"
import {StorageService} from "./storage/Services"
import {SysService} from "./sys/Services"
import {TutanotaService} from "./tutanota/Services"
import {TutanotaError} from "../common/error/TutanotaError"

type Service = MonitorServiceType
	| AccountingServiceType
	| BaseServiceType
	| GossipServiceType
	| StorageServiceType
	| SysServiceType
	| TutanotaServiceType

export function getRestPath(service: Service): string {
	return `/rest/${getModelString(service)}/${service}`
}

function getModelString(service: Service): string {
	if (Object.values(TutanotaService).includes(service)) {
		return "tutanota"
	} else if (Object.values(SysService).includes(service)) {
		return "sys"
	} else if (Object.values(MonitorService).includes(service)) {
		return "monitor"
	} else if (Object.values(AccountingService).includes(service)) {
		return "accounting"
	} else if (Object.values(BaseService).includes(service)) {
		return "base"
	} else if (Object.values(GossipService).includes(service)) {
		return "gossip"
	} else if (Object.values(StorageService).includes(service)) {
		return "storage"
	} else {
		throw new TutanotaError("unknown service", `cannot get model name of unknown service: ${service}`)
	}
}