// Stateful optical-flow and image-registration trackers.

import AppKit
import CoreGraphics
import CoreImage
import CoreML
import CoreVideo
import Foundation
import ImageIO
import Vision

@_cdecl("vn_optical_flow_tracker_create")
public func vn_optical_flow_tracker_create(
    _ referencePath: UnsafePointer<CChar>,
    _ outHandle: UnsafeMutablePointer<UnsafeMutableRawPointer?>,
    _ outErrorMessage: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
    outHandle.pointee = nil
    guard #available(macOS 14.0, *) else {
        outErrorMessage?.pointee = ffiString("VNTrackOpticalFlowRequest requires macOS 14+")
        return VN_REQUEST_FAILED
    }
    let path = String(cString: referencePath)
    guard let image = loadCGImage(path: path) else {
        outErrorMessage?.pointee = ffiString("could not load image at \(path)")
        return VN_IMAGE_LOAD_FAILED
    }
    do {
        let tracker = try OpticalFlowTrackerSession(referenceImage: image)
        outHandle.pointee = Unmanaged.passRetained(tracker).toOpaque()
        return VN_OK
    } catch {
        outErrorMessage?.pointee = ffiString("optical flow tracker create failed: \(error.localizedDescription)")
        return VN_REQUEST_FAILED
    }
}

@_cdecl("vn_optical_flow_tracker_track")
public func vn_optical_flow_tracker_track(
    _ handle: UnsafeMutableRawPointer?,
    _ nextPath: UnsafePointer<CChar>,
    _ outMaskRaw: UnsafeMutableRawPointer,
    _ outErrorMessage: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
    let outMask = outMaskRaw.assumingMemoryBound(to: VNSegmentationMaskRaw.self)
    outMask.pointee = VNSegmentationMaskRaw(width: 0, height: 0, bytes_per_row: 0, bytes: nil)
    guard let handle else {
        outErrorMessage?.pointee = ffiString("null optical-flow tracker handle")
        return VN_INVALID_ARGUMENT
    }
    guard #available(macOS 14.0, *) else {
        outErrorMessage?.pointee = ffiString("VNTrackOpticalFlowRequest requires macOS 14+")
        return VN_REQUEST_FAILED
    }
    let path = String(cString: nextPath)
    guard let image = loadCGImage(path: path) else {
        outErrorMessage?.pointee = ffiString("could not load image at \(path)")
        return VN_IMAGE_LOAD_FAILED
    }
    let tracker = Unmanaged<OpticalFlowTrackerSession>.fromOpaque(handle).takeUnretainedValue()
    do {
        outMask.pointee = try tracker.track(nextImage: image)
        return VN_OK
    } catch {
        outErrorMessage?.pointee = ffiString("optical flow tracker track failed: \(error.localizedDescription)")
        return VN_REQUEST_FAILED
    }
}

@_cdecl("vn_optical_flow_tracker_release")
public func vn_optical_flow_tracker_release(_ handle: UnsafeMutableRawPointer?) {
    guard let handle else { return }
    if #available(macOS 14.0, *) {
        Unmanaged<OpticalFlowTrackerSession>.fromOpaque(handle).release()
    }
}

@_cdecl("vn_translational_image_tracker_create")
public func vn_translational_image_tracker_create(
    _ referencePath: UnsafePointer<CChar>,
    _ outHandle: UnsafeMutablePointer<UnsafeMutableRawPointer?>,
    _ outErrorMessage: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
    outHandle.pointee = nil
    guard #available(macOS 14.0, *) else {
        outErrorMessage?.pointee = ffiString("VNTrackTranslationalImageRegistrationRequest requires macOS 14+")
        return VN_REQUEST_FAILED
    }
    let path = String(cString: referencePath)
    guard let image = loadCGImage(path: path) else {
        outErrorMessage?.pointee = ffiString("could not load image at \(path)")
        return VN_IMAGE_LOAD_FAILED
    }
    do {
        let tracker = try TranslationalImageTrackerSession(referenceImage: image)
        outHandle.pointee = Unmanaged.passRetained(tracker).toOpaque()
        return VN_OK
    } catch {
        outErrorMessage?.pointee = ffiString("translational tracker create failed: \(error.localizedDescription)")
        return VN_REQUEST_FAILED
    }
}

@_cdecl("vn_translational_image_tracker_track")
public func vn_translational_image_tracker_track(
    _ handle: UnsafeMutableRawPointer?,
    _ nextPath: UnsafePointer<CChar>,
    _ outAlignmentRaw: UnsafeMutableRawPointer,
    _ outErrorMessage: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
    let outAlignment = outAlignmentRaw.assumingMemoryBound(to: VNTranslationalAlignmentRaw.self)
    outAlignment.pointee = VNTranslationalAlignmentRaw(tx: 0, ty: 0)
    guard let handle else {
        outErrorMessage?.pointee = ffiString("null translational tracker handle")
        return VN_INVALID_ARGUMENT
    }
    guard #available(macOS 14.0, *) else {
        outErrorMessage?.pointee = ffiString("VNTrackTranslationalImageRegistrationRequest requires macOS 14+")
        return VN_REQUEST_FAILED
    }
    let path = String(cString: nextPath)
    guard let image = loadCGImage(path: path) else {
        outErrorMessage?.pointee = ffiString("could not load image at \(path)")
        return VN_IMAGE_LOAD_FAILED
    }
    let tracker = Unmanaged<TranslationalImageTrackerSession>.fromOpaque(handle).takeUnretainedValue()
    do {
        outAlignment.pointee = try tracker.track(nextImage: image)
        return VN_OK
    } catch {
        outErrorMessage?.pointee = ffiString("translational tracker track failed: \(error.localizedDescription)")
        return VN_REQUEST_FAILED
    }
}

@_cdecl("vn_translational_image_tracker_release")
public func vn_translational_image_tracker_release(_ handle: UnsafeMutableRawPointer?) {
    guard let handle else { return }
    if #available(macOS 14.0, *) {
        Unmanaged<TranslationalImageTrackerSession>.fromOpaque(handle).release()
    }
}

@_cdecl("vn_homographic_image_tracker_create")
public func vn_homographic_image_tracker_create(
    _ referencePath: UnsafePointer<CChar>,
    _ outHandle: UnsafeMutablePointer<UnsafeMutableRawPointer?>,
    _ outErrorMessage: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
    outHandle.pointee = nil
    guard #available(macOS 14.0, *) else {
        outErrorMessage?.pointee = ffiString("VNTrackHomographicImageRegistrationRequest requires macOS 14+")
        return VN_REQUEST_FAILED
    }
    let path = String(cString: referencePath)
    guard let image = loadCGImage(path: path) else {
        outErrorMessage?.pointee = ffiString("could not load image at \(path)")
        return VN_IMAGE_LOAD_FAILED
    }
    do {
        let tracker = try HomographicImageTrackerSession(referenceImage: image)
        outHandle.pointee = Unmanaged.passRetained(tracker).toOpaque()
        return VN_OK
    } catch {
        outErrorMessage?.pointee = ffiString("homographic tracker create failed: \(error.localizedDescription)")
        return VN_REQUEST_FAILED
    }
}

@_cdecl("vn_homographic_image_tracker_track")
public func vn_homographic_image_tracker_track(
    _ handle: UnsafeMutableRawPointer?,
    _ nextPath: UnsafePointer<CChar>,
    _ outAlignmentRaw: UnsafeMutableRawPointer,
    _ outErrorMessage: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
    let outAlignment = outAlignmentRaw.assumingMemoryBound(to: VNHomographicAlignmentRaw.self)
    outAlignment.pointee = VNIdentityHomographicAlignmentRaw.value
    guard let handle else {
        outErrorMessage?.pointee = ffiString("null homographic tracker handle")
        return VN_INVALID_ARGUMENT
    }
    guard #available(macOS 14.0, *) else {
        outErrorMessage?.pointee = ffiString("VNTrackHomographicImageRegistrationRequest requires macOS 14+")
        return VN_REQUEST_FAILED
    }
    let path = String(cString: nextPath)
    guard let image = loadCGImage(path: path) else {
        outErrorMessage?.pointee = ffiString("could not load image at \(path)")
        return VN_IMAGE_LOAD_FAILED
    }
    let tracker = Unmanaged<HomographicImageTrackerSession>.fromOpaque(handle).takeUnretainedValue()
    do {
        outAlignment.pointee = try tracker.track(nextImage: image)
        return VN_OK
    } catch {
        outErrorMessage?.pointee = ffiString("homographic tracker track failed: \(error.localizedDescription)")
        return VN_REQUEST_FAILED
    }
}

@_cdecl("vn_homographic_image_tracker_release")
public func vn_homographic_image_tracker_release(_ handle: UnsafeMutableRawPointer?) {
    guard let handle else { return }
    if #available(macOS 14.0, *) {
        Unmanaged<HomographicImageTrackerSession>.fromOpaque(handle).release()
    }
}
