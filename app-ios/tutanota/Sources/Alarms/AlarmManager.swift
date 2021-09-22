import Foundation

enum Operation: String {
  case Create = "0"
  case Update = "1"
  case Delete = "2"
}

// iOS (13.3 at least) has a limit on saved alarms which empirically inferred to be.
// It means that only *last* 64 alarms are stored in the internal plist by SpringBoard.
// If we schedule too many some alarms will not be fired. We should be careful to not
// schedule too far into the future.
//
// Better approach would be to calculate occurences from all alarms, sort them and take
// the first 64. Or schedule later ones first so that newer ones have higher priority.
let EVENTS_SCHEDULED_AHEAD = 24

let MISSED_NOTIFICATION_TTL_SEC: Int64 = 30 * 24 * 60 * 60; // 30 days

enum HttpStatusCode: Int {
  case ok = 200
  case notAuthenticated = 401
  case notFound = 404
  case tooManyRequests = 429
  case serviceUnavailable = 503
}

@objc
class AlarmManager : NSObject {
  private let keychainManager: KeychainManager
  private let userPreference: TUTUserPreferenceFacade
  private let fetchQueue: OperationQueue
  
  init(keychainManager: KeychainManager, userPreference: TUTUserPreferenceFacade) {
    self.keychainManager = keychainManager
    self.userPreference = userPreference
    self.fetchQueue = OperationQueue()
    self.fetchQueue.maxConcurrentOperationCount = 1
  }
  
  @objc
  func fetchMissedNotifications(_ completionHandler: @escaping (Error?) -> Void) {
    self.fetchQueue.addAsyncOperation {[weak self] queueCompletionHandler in
      guard let self = self else {
        return
      }
      func complete(error: Error?) {
        queueCompletionHandler()
        completionHandler(error)
      }
      
      guard let sseInfo = self.userPreference.sseInfo() else {
        TUTSLog("No stored SSE info")
        complete(error: nil)
        return
      }
      
      var additionalHeaders = [String: String]()
      addSystemModelHeaders(to: &additionalHeaders)
      
      if sseInfo.userIds.isEmpty {
        TUTSLog("No users to download missed notification with")
        self.unscheduleAllAlarms(userId: nil)
        complete(error: nil)
        return
      }
      
      let userId: String = sseInfo.userIds[0]
      additionalHeaders["userId"] = userId
      if let lastNoficationId = self.userPreference.lastProcessedNotificationId {
        additionalHeaders["lastProcessedNotificationId"] = lastNoficationId
      }
      let configuration = URLSessionConfiguration.ephemeral
      configuration.httpAdditionalHeaders = additionalHeaders
      
      let urlSession = URLSession(configuration: configuration)
      let urlString = self.missedNotificationUrl(origin: sseInfo.sseOrigin, pushIdentifier: sseInfo.pushIdentifier)
      
      TUTSLog("Downloading missed notification with userId \(userId)")
      
      urlSession.dataTask(with: URL(string: urlString)!) { data, response, error in
        if let error = error {
          TUTSLog("Fetched missed notifications with errror \(error)")
          complete(error: error)
          return
        }
        let httpResponse = response as! HTTPURLResponse
        TUTSLog("Fetched missed notifications with status code \(httpResponse.statusCode)")
        switch (HttpStatusCode.init(rawValue: httpResponse.statusCode)) {
        case .notAuthenticated:
          TUTSLog("Not authenticated to download missed notification w/ user \(userId)")
          self.unscheduleAllAlarms(userId: userId)
          self.userPreference.removeUser(userId)
          queueCompletionHandler()
          self.fetchMissedNotifications(completionHandler)
        case .serviceUnavailable, .tooManyRequests:
          let suspensionTime = extractSuspensionTime(from: httpResponse)
          TUTSLog("SericeUnavailable when downloading missed notification, waiting for \(suspensionTime)s")
          DispatchQueue.main
            .asyncAfter(deadline: .now() + .seconds(suspensionTime)) {
              self.fetchMissedNotifications(completionHandler)
            }
          queueCompletionHandler()
        case .notFound:
          complete(error: nil)
        case .ok:
          self.userPreference.lastMissedNotificationCheckTime = Date()
          let json: [String: Any]
          do {
            json = try JSONSerialization.jsonObject(with: data!, options: []) as! [String : Any]
          } catch {
            TUTSLog("Failed to parse response for the missed notification request")
            complete(error: error)
            return
          }
          let missedNotification = TUTMissedNotification .fromJSON(json)
          self.userPreference.lastProcessedNotificationId = missedNotification.lastProcessedNotificationId
          self.processNewAlarms(missedNotification.alarmNotifications, completion: complete)
        default:
          let error = NSError(domain: TUT_NETWORK_ERROR, code: httpResponse.statusCode, userInfo: [
            "message": "Failed to fetch missed notification"
          ])
          complete(error: error)
        }
      }.resume()
    }
  }
  
  @objc
  func processNewAlarms(_ notifications: Array<TUTAlarmNotification>, completion: @escaping (Error?) -> Void) {
    DispatchQueue.global(qos: .utility).async {
      var savedNotifications = self.userPreference.alarms()
      var resultError: Error?
      for alarmNotification in notifications {
        do {
          try self.handleAlarmNotification(alarmNotification, existringAlarms: &savedNotifications)
        } catch {
          TUTSLog("Errror while handling alarm \(error)")
          resultError = error
        }
      }
      
      TUTSLog("Finished processing \(notifications.count) alarms")
      self.userPreference.storeAlarms(savedNotifications)
      completion(resultError)
    }
  }
  
  @objc
  func hasNotificationTTLExpired() -> Bool {
    guard let lastMissedNotificationCheckTime = userPreference.lastMissedNotificationCheckTime else {
      return false
    }
    let sinceNow = lastMissedNotificationCheckTime.timeIntervalSinceNow
    // Important: timeIntervalSinceNow is negative if it's in the past
    return sinceNow < 0 && Int64(abs(sinceNow)) > MISSED_NOTIFICATION_TTL_SEC
  }
  
  @objc
  func resetStoredState() {
    TUTSLog("Resetting stored state")
    self.unscheduleAllAlarms(userId: nil)
    userPreference.clear()
    do {
      try keychainManager.removePushIdentifierKeys()
    } catch {
      TUTSLog("Faied to remove pushIdentifier keys \(error)")
    }
  }
  
  @objc
  func rescheduleAlarms() {
    TUTSLog("Re-scheduling alarms")
    DispatchQueue.global(qos: .background).async {
      for notification in self.savedAlarms() {
        autoreleasepool {
          do {
            try self.scheduleAlarm(notification)
          } catch {
            TUTSLog("Error when re-scheduling alarm \(notification) \(error)")
          }
        }
      }
    }
  }
  
  private func savedAlarms() -> Set<TUTAlarmNotification> {
    let savedNotifications = self.userPreference.alarms()
    let set = Set(savedNotifications)
    if set.count != savedNotifications.count {
      TUTSLog("Duplicated alarms detected, re-saving...")
      self.userPreference.storeAlarms(Array(set))
    }
    return set
  }
  
  private func handleAlarmNotification(
    _ alarm: TUTAlarmNotification,
    existringAlarms: inout Array<TUTAlarmNotification>
  ) throws {
    switch Operation(rawValue: alarm.operation) {
    case .Create:
      do {
        try self.scheduleAlarm(alarm)
        if !existringAlarms.contains(alarm) {
          existringAlarms.append(alarm)
        }
      } catch {
        throw error
      }
    case .Delete:
      let alarmToUnschedule = existringAlarms.first { $0 == alarm } ?? alarm
      do {
        try self.unscheduleAlarm(alarmToUnschedule)
      } catch {
        TUTSLog("Failed to cancel alarm \(alarm) \(error)")
        throw error
      }
      if let index = existringAlarms.firstIndex(of: alarmToUnschedule) {
        existringAlarms.remove(at: index)
      }
    default:
      fatalError("Unexpected operation for alarm: \(alarm.operation)")
    }
  }
  
  private func unscheduleAllAlarms(userId: String?) {
    let alarms = self.userPreference.alarms()
    for alarm in alarms {
      if userId != nil && userId != alarm.user {
        continue
      }
      do {
        try self.unscheduleAlarm(alarm)
      } catch {
        TUTSLog("Error while unscheduling of all alarms \(error)")
      }
    }
  }
  
  private func missedNotificationUrl(origin: String, pushIdentifier: String) -> String {
    let base64UrlId = stringToCustomId(customId: pushIdentifier)
    return "\(origin)/rest/sys/missednotification/\(base64UrlId)"
  }
  
  private func scheduleAlarm(_ alarmNotification: TUTAlarmNotification) throws {
    let alarmIdentifier = alarmNotification.alarmInfo.alarmIdentifier
    let sessionKey = self.resolveSessionkey(alarmNotification: alarmNotification)
    guard let sessionKey = sessionKey else {
      throw TUTErrorFactory.createError("Cannot resolve session key")
    }
    let startDate = try alarmNotification.getEventStartDec(sessionKey)
    let endDate = try alarmNotification.getEventEndDec(sessionKey)
    let trigger = try alarmNotification.alarmInfo.getTriggerDec(sessionKey)
    let summary = try alarmNotification.getSummaryDec(sessionKey)
    
    var occurrences = [OcurrenceInfo]()
    if let repeatRule = alarmNotification.repeatRule {
      occurrences = try self.iterateRepeatingAlarm(
        eventStart: startDate,
        eventEnd: endDate,
        trigger: trigger,
        repeatRule: repeatRule,
        sessionKey: sessionKey
      )
    } else {
      let singleOcurrence = OcurrenceInfo(occurrence: 0, ocurrenceTime: startDate)
      occurrences = [singleOcurrence]
    }
    for ocurrence in occurrences {
      self.scheduleAlarmOcurrence(
        ocurrenceInfo: ocurrence,
        trigger: trigger,
        summary: summary,
        alarmIdentifier: alarmIdentifier
      )
    }
  }
  
  private func unscheduleAlarm(_ alarmNotification: TUTAlarmNotification) throws {
    let alarmIdentifier = alarmNotification.alarmInfo.alarmIdentifier
    let occurrenceIds: [String]
    if let repeatRule = alarmNotification.repeatRule {
      let sessionKey = self.resolveSessionkey(alarmNotification: alarmNotification)
      guard let sessionKey = sessionKey else {
        throw TUTErrorFactory.createError("Cannot resolve session key on unschedule \(alarmNotification.alarmInfo.alarmIdentifier)")
      }
      let startDate = try alarmNotification.getEventStartDec(sessionKey)
      let endDate = try alarmNotification.getEventEndDec(sessionKey)
      let trigger = try alarmNotification.alarmInfo.getTriggerDec(sessionKey)
      
      let ocurrences = try self.iterateRepeatingAlarm(
        eventStart: startDate,
        eventEnd: endDate,
        trigger: trigger,
        repeatRule: repeatRule,
        sessionKey: sessionKey
      )
      occurrenceIds = ocurrences.map { o in
        ocurrenceIdentifier(alarmIdentifier: alarmIdentifier, occurrence: o.occurrence)
      }
    } else {
      occurrenceIds = [ocurrenceIdentifier(alarmIdentifier: alarmIdentifier, occurrence: 0)]
    }
    TUTSLog("Cancelling alarm \(alarmIdentifier)")
    UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: occurrenceIds)
  }
  
  private func resolveSessionkey(alarmNotification: TUTAlarmNotification) -> Data? {
    var lastError: Error?
    for notificationSessionKey in alarmNotification.notificationSessionKeys {
      do {
        let pushIdentifierSessionKey = try self.keychainManager
          .getKey(keyId: notificationSessionKey.pushIdentifier.elementId)
        guard let pushIdentifierSessionKey = pushIdentifierSessionKey else {
          continue
        }
        let encSessionKey = Data(base64Encoded: notificationSessionKey.pushIdentifierSessionEncSessionKey)
        return try TUTAes128Facade.decryptKey(encSessionKey, withEncryptionKey: pushIdentifierSessionKey)
      } catch {
        TUTSLog("Failed to decrypt key \(notificationSessionKey.pushIdentifier.elementId) \(error)")
        lastError = error
      }
    }
    TUTSLog("Failed to resolve session key \(alarmNotification.alarmInfo.alarmIdentifier), last error: \(String(describing: lastError))")
    return nil
  }
  
  private func iterateRepeatingAlarm(
    eventStart: Date,
    eventEnd: Date,
    trigger: String,
    repeatRule: TUTRepeatRule,
    sessionKey: Data
  ) throws -> [OcurrenceInfo] {
    let timeZoneName = try repeatRule.getTimezoneDec(sessionKey)
    
    var errorPointer: NSError?
    let frequeency = repeatRule.getFrequencyDec(sessionKey, error: &errorPointer)
    let interval = repeatRule.getIntervalDec(sessionKey, error: &errorPointer)
    let endType = repeatRule.getEndTypeDec(sessionKey, error: &errorPointer)
    let envValue = repeatRule.getEndValueDec(sessionKey, error: &errorPointer)
    if let error = errorPointer {
      TUTSLog("Could not decrypt repeating alarm \(error)")
      throw error
    }
    
    let now = Date()
    var ocurrences = [OcurrenceInfo]()
    TUTAlarmModel.iterateRepeatingAlarm(
      withNow: now,
      timeZone: timeZoneName,
      eventStart: eventStart,
      eventEnd: eventEnd,
      repeatPerioud: frequeency,
      interval: interval,
      endType: endType,
      endValue: envValue,
      localTimeZone: TimeZone.current,
      scheduleAhead: EVENTS_SCHEDULED_AHEAD
    ) { ocurrnce, occurrenceTime in
      let info = OcurrenceInfo(
        occurrence: Int(ocurrnce),
        ocurrenceTime: occurrenceTime
      )
      ocurrences.append(info)
    }
    return ocurrences
  }
  
  private func scheduleAlarmOcurrence(
    ocurrenceInfo: OcurrenceInfo,
    trigger: String,
    summary: String,
    alarmIdentifier: String
  ) {
    let alarmTime = TUTAlarmModel.alarmTime(withTrigger: trigger, eventTime: ocurrenceInfo.ocurrenceTime)
    
    if alarmTime.timeIntervalSinceNow < 0 {
      TUTSLog("Even alarm is in the past \(alarmIdentifier) \(alarmTime)")
      return
    }
    let fortNightSeconds: Double = 60 * 60 * 24 * 14
    if alarmTime.timeIntervalSinceNow > fortNightSeconds {
      TUTSLog("Event alarm is too far into the future \(alarmIdentifier) \(alarmTime)")
    }
    
    let formmatedTime = DateFormatter.localizedString(
      from: ocurrenceInfo.ocurrenceTime,
      dateStyle: .short,
      timeStyle: .short
    )
    let notificationText = "\(formmatedTime): \(summary)"
    let cal = Calendar.current
    let dateComponents = cal.dateComponents(
      [.year, .month, .day, .hour, .minute],
      from: alarmTime
    )
    let notificationTrigger = UNCalendarNotificationTrigger(
      dateMatching: dateComponents,
      repeats: false
    )
    let content = UNMutableNotificationContent()
    content.title = TUTUtils.translate("TutaoCalendarAlarmTitle", default: "Reminder")
    content.body = notificationText
    content.sound = UNNotificationSound.default
    
    let identifier = ocurrenceIdentifier(
      alarmIdentifier: alarmIdentifier,
      occurrence: ocurrenceInfo.occurrence
    )
    let request = UNNotificationRequest(
      identifier: identifier,
      content: content,
      trigger: notificationTrigger
    )
    TUTSLog("Scheduling a notification \(identifier) at \(cal.date(from: dateComponents)!)")
    UNUserNotificationCenter.current().add(request) { error in
      if let error = error {
        // We should make the whole funciton async and wait for it
        TUTSLog("Failed to schedule a notification \(error)")
      }
    }
  }
}

func stringToCustomId(customId: String) -> String {
  return customId.data(using: .utf8)!
    .base64EncodedString()
    .replacingOccurrences(of: "+", with: "-")
    .replacingOccurrences(of: "/", with: "_")
    .replacingOccurrences(of: "=", with: "")
}

func addSystemModelHeaders(to target: inout [String: String]) {
  target["v"] = String(SYS_MODEL_VERSION)
}

/**
 Gets suspension time from the request in seconds
 */
func extractSuspensionTime(from httpResponse: HTTPURLResponse) -> Int {
  let retryAfterHeader =
    (httpResponse.allHeaderFields["Retry-After"] ?? httpResponse.allHeaderFields["Suspension-Time"])
    as! String?
  return retryAfterHeader.flatMap { Int($0) } ?? 0
}

struct OcurrenceInfo {
  let occurrence: Int
  let ocurrenceTime: Date
}

private func ocurrenceIdentifier(alarmIdentifier: String, occurrence: Int) -> String {
  return "\(alarmIdentifier)#\(occurrence)"
}
