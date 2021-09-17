import UIKit

@UIApplicationMain
class AppDelegate : UIResponder,
                    UIApplicationDelegate,
                    UNUserNotificationCenterDelegate {
  var window: UIWindow?
  
  private var pushTokenCallback: ((String?, Error?) -> Void)?
  private let userPreferences = TUTUserPreferenceFacade()
  private var alarmManager: TUTAlarmManager!
  private var viewController: TUTViewController!
  
  @objc
  func registerForPushNotifications(
    callback: @escaping (String?, Error?) -> Void
  ) {
    UNUserNotificationCenter.current()
      .requestAuthorization(
        options: [.alert, .badge, .sound]) { granted, error in
        if error == nil {
          DispatchQueue.main.async {
            self.pushTokenCallback = callback
            UIApplication.shared.registerForRemoteNotifications()
          }
        } else {
          callback(nil, error)
        }
      }
  }
  
  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey : Any]?
  ) -> Bool {
    TUTSLog("Start Tutanota \(String(describing: launchOptions))")
    self.alarmManager = TUTAlarmManager(userPreferences: userPreferences)
    self.window = UIWindow(frame: UIScreen.main.bounds)
    self.viewController = TUTViewController(
      preferenceFacade: self.userPreferences,
      alarmManager: self.alarmManager
    )
    self.window!.rootViewController = viewController
    
    UNUserNotificationCenter.current().delegate = self
    
    window!.makeKeyAndVisible()
    
    return true
  }
  
  func applicationWillEnterForeground(_ application: UIApplication) {
    UIApplication.shared.applicationIconBadgeNumber = 0
  }
  
  func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
    if let callback = self.pushTokenCallback {
      let stringToken = deviceTokenAsString(deviceToken: deviceToken)
      callback(stringToken, nil)
      self.pushTokenCallback = nil
    }
  }
  
  func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
    self.pushTokenCallback?(nil, error)
    self.pushTokenCallback = nil
  }
  
  func application(
    _ application: UIApplication,
    didReceiveRemoteNotification userInfo: [AnyHashable : Any],
    fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void) {
    let apsDict = userInfo["aps"] as! Dictionary<String, Any>
    TUTSLog("Received notification \(userInfo)")
    
    let contentAvailable = apsDict["content-available"]
    if contentAvailable as? Int == 1 {
      self.alarmManager.fetchMissedNotifications { err in
        TUTSLog("Fetched missed notificaiton \(String(describing: err))")
        completionHandler(err != nil ? .failed : .newData)
      }
    }
  }
}

func deviceTokenAsString(deviceToken: Data) -> String? {
  if deviceToken.isEmpty {
    return nil
  }
  var result = ""
  for byte in deviceToken {
    result = result.appendingFormat("%02x", byte)
  }
  return result
}
