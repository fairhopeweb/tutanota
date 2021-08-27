// @flow

export const TutanotaService = Object.freeze({
	ExternalUserService: "externaluserservice",
	MailService: "mailservice",
	PasswordMessagingService: "passwordmessagingservice",
	PasswordAutoAuthenticationService: "passwordautoauthenticationservice",
	PasswordRetrievalService: "passwordretrievalservice",
	PasswordChannelResource: "passwordchannelresource",
	FileDataService: "filedataservice",
	FileBlobService: "fileblobservice",
	MoveMailService: "movemailservice",
	MailFolderService: "mailfolderservice",
	EncryptTutanotaPropertiesService: "encrypttutanotapropertiesservice",
	DraftService: "draftservice",
	SendDraftService: "senddraftservice",
	ReceiveInfoService: "receiveinfoservice",
	UserAccountService: "useraccountservice",
	MailGroupService: "mailgroupservice",
	LocalAdminGroupService: "localadmingroupservice",
	ContactFormAccountService: "contactformaccountservice",
	ListUnsubscribeService: "listunsubscribeservice",
	CalendarService: "calendarservice",
	GroupInvitationService: "groupinvitationservice",
	ReportMailService: "reportmailservice",
	EntropyService: "entropyservice",
	TemplateGroupService: "templategroupservice"
})

export type TutanotaServiceType = $Values<typeof TutanotaService>

export function getRestPath(service: TutanotaServiceType): string {
	return `/rest/tutanota/${service}`
}