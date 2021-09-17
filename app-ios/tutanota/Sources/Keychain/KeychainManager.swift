import Foundation

let TAG = "de.tutao.tutanota.notificationkey."

@objc
class KeychainManager : NSObject {
  @objc
  func storeKey(_ key: Data, withId keyId: String) throws {
    let keyTag = self.keyTagFromKeyId(keyId: keyId)
    
    let existingKey = try? self.getKeyImpl(keyId: keyId)
    
    let status: OSStatus
    
    if let key = existingKey {
      let updateQuery: [String: Any] = [
        kSecClass as String: kSecClassKey,
        kSecAttrApplicationTag as String: keyTag
      ]
      let updateFields: [String: Any] = [
        kSecValueData as String: key,
        kSecAttrAccessible as String: kSecAttrAccessibleAlwaysThisDeviceOnly
      ]
      status = SecItemUpdate(updateQuery as CFDictionary, updateFields as CFDictionary)
    } else {
      let addQuery: [String: Any] = [
        kSecValueData as String: key,
        kSecClass as String: kSecClassKey,
        kSecAttrApplicationTag as String: keyTag,
        kSecAttrAccessible as String: kSecAttrAccessibleAlwaysThisDeviceOnly
      ]
      status = SecItemAdd(addQuery as CFDictionary, nil)
    }
    if status != errSecSuccess {
      throw TUTErrorFactory.createError("Could not store the key, status: \(status)")
    }
  }
  
  // We can't throw because we return optional and call it from objc
  @objc
  func getKey(keyId: String, error errorPointer: ErrorPointer) -> Data? {
    do {
      return try self.getKeyImpl(keyId: keyId)
    } catch {
      errorPointer?.pointee = error as NSError
      return nil
    }
  }
  
  @objc
  func removePushIdentifierKeys() throws {
    let deleteQuery: [String: Any] = [
      kSecClass as String: kSecClassKey
    ]
    let status = SecItemDelete(deleteQuery as CFDictionary)
    if status != errSecSuccess {
      throw TUTErrorFactory .createError("Could not delete the keys, status: \(status)")
    }
  }
  
  private func getKeyImpl(keyId: String) throws -> Data? {
    let keyTag = self.keyTagFromKeyId(keyId: keyId)
    let getQuery: [String : Any] = [
      kSecClass as String: kSecClassKey,
      kSecAttrApplicationTag as String: keyTag,
      kSecReturnData as String: true
    ]
    var item: CFTypeRef?
    let status = SecItemCopyMatching(getQuery as CFDictionary, &item)
    if (status != errSecSuccess) {
      throw TUTErrorFactory.createError("Failed to get key \(keyId). status: \(status)") as NSError
    } else if let item = item {
      return (item as! Data)
    } else {
      return nil
    }
  }
  
  private func keyTagFromKeyId(keyId: String) -> Data {
    let keyTag = TAG + keyId
    return keyTag.data(using: .utf8)!
  }
}
