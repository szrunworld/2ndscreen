import AudioToolbox
import Foundation

/// The Mac's output volume, as the menu bar's Sound control sets it. Apps
/// such as iPhone Mirroring play through it and have no volume of their own.
public enum SystemVolume {
    private static var outputDevice: AudioDeviceID? {
        var device = AudioDeviceID(0)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultOutputDevice,
            mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        let status = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &device)
        return status == noErr && device != 0 ? device : nil
    }

    private static func address(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioDevicePropertyScopeOutput,
                                   mElement: kAudioObjectPropertyElementMain)
    }

    /// 0...1, or nil when the output device has no volume control.
    public static var level: Float? {
        get {
            guard let device = outputDevice else { return nil }
            var address = address(kAudioHardwareServiceDeviceProperty_VirtualMainVolume)
            guard AudioObjectHasProperty(device, &address) else { return nil }
            var value = Float32(0)
            var size = UInt32(MemoryLayout<Float32>.size)
            return AudioObjectGetPropertyData(device, &address, 0, nil, &size, &value) == noErr ? value : nil
        }
        set {
            guard let newValue, let device = outputDevice else { return }
            var address = address(kAudioHardwareServiceDeviceProperty_VirtualMainVolume)
            var value = Float32(min(max(newValue, 0), 1))
            AudioObjectSetPropertyData(device, &address, 0, nil, UInt32(MemoryLayout<Float32>.size), &value)
            if value > 0, muted == true { muted = false }
        }
    }

    public static var muted: Bool? {
        get {
            guard let device = outputDevice else { return nil }
            var address = address(kAudioDevicePropertyMute)
            guard AudioObjectHasProperty(device, &address) else { return nil }
            var value = UInt32(0)
            var size = UInt32(MemoryLayout<UInt32>.size)
            return AudioObjectGetPropertyData(device, &address, 0, nil, &size, &value) == noErr ? value != 0 : nil
        }
        set {
            guard let newValue, let device = outputDevice else { return }
            var address = address(kAudioDevicePropertyMute)
            var value = UInt32(newValue ? 1 : 0)
            AudioObjectSetPropertyData(device, &address, 0, nil, UInt32(MemoryLayout<UInt32>.size), &value)
        }
    }
}
