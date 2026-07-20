// Additional pose bridges added in the v0.13 coverage sweep.

import AppKit
import CoreGraphics
import CoreImage
import CoreML
import CoreVideo
import Foundation
import ImageIO
import Vision

// MARK: - Shared simple-rect struct (also used for v0.13 text rectangles +
// objectness saliency).

@frozen
public struct VNSimpleRectRaw {
    public var x: Double
    public var y: Double
    public var w: Double
    public var h: Double
    public var confidence: Float
    public var _pad: Float
}

@_cdecl("vn_simple_rects_free")
public func vn_simple_rects_free(_ ptr: UnsafeMutableRawPointer?, _ count: Int) {
    guard let ptr = ptr else { return }
    let typed = ptr.assumingMemoryBound(to: VNSimpleRectRaw.self)
    typed.deinitialize(count: count)
    typed.deallocate()
}

internal func mkRect(_ r: CGRect, _ c: Float) -> VNSimpleRectRaw {
    VNSimpleRectRaw(x: Double(r.origin.x), y: Double(r.origin.y),
                    w: Double(r.size.width), h: Double(r.size.height),
                    confidence: c, _pad: 0)
}

// MARK: - Animal body pose (macOS 14+)

@frozen
public struct VNAnimalJointRaw {
    /// Joint name (UTF-8, heap-allocated, free with vn_string_free).
    public var name: UnsafeMutablePointer<CChar>?
    public var x: Double
    public var y: Double
    public var confidence: Float
    public var _pad: Float
}

@_cdecl("vn_detect_animal_body_pose_in_path")
public func vn_detect_animal_body_pose_in_path(
    _ path: UnsafePointer<CChar>,
    _ out_joints_raw: UnsafeMutableRawPointer,
    _ out_count: UnsafeMutablePointer<Int>,
    _ outErrorMessage: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
    let out_joints = out_joints_raw.assumingMemoryBound(to: UnsafeMutablePointer<VNAnimalJointRaw>?.self)
    out_joints.pointee = nil
    out_count.pointee = 0
    if #available(macOS 14.0, *) {
        let p = String(cString: path)
        guard let img = loadCGImage(path: p) else {
            outErrorMessage?.pointee = ffiString("could not load image at \(p)")
            return VN_IMAGE_LOAD_FAILED
        }
        let req = VNDetectAnimalBodyPoseRequest()
        let handler = VNImageRequestHandler(cgImage: img, options: [:])
        do { try handler.perform([req]) } catch {
            outErrorMessage?.pointee = ffiString("animal body pose request failed: \(error.localizedDescription)")
            return VN_REQUEST_FAILED
        }
        guard let obs = req.results?.first else { return VN_OK }
        let names: [VNAnimalBodyPoseObservation.JointName] = [
            .leftEarTop, .leftEarMiddle, .leftEarBottom,
            .rightEarTop, .rightEarMiddle, .rightEarBottom,
            .leftEye, .rightEye,
            .nose, .neck,
            .leftFrontElbow, .leftFrontKnee, .leftFrontPaw,
            .rightFrontElbow, .rightFrontKnee, .rightFrontPaw,
            .leftBackElbow, .leftBackKnee, .leftBackPaw,
            .rightBackElbow, .rightBackKnee, .rightBackPaw,
            .tailTop, .tailMiddle, .tailBottom,
        ]
        var joints: [VNAnimalJointRaw] = []
        for n in names {
            guard let pt = try? obs.recognizedPoint(n), pt.confidence > 0 else { continue }
            joints.append(VNAnimalJointRaw(
                name: ffiString(n.rawValue.rawValue),
                x: Double(pt.location.x), y: Double(pt.location.y),
                confidence: pt.confidence, _pad: 0
            ))
        }
        if joints.isEmpty { return VN_OK }
        let buf = UnsafeMutablePointer<VNAnimalJointRaw>.allocate(capacity: joints.count)
        buf.initialize(from: &joints, count: joints.count)
        out_joints.pointee = buf
        out_count.pointee = joints.count
        return VN_OK
    }
    return VN_REQUEST_FAILED
}

@_cdecl("vn_animal_joints_free")
public func vn_animal_joints_free(_ ptr: UnsafeMutableRawPointer?, _ count: Int) {
    guard let ptr = ptr else { return }
    let typed = ptr.assumingMemoryBound(to: VNAnimalJointRaw.self)
    for i in 0..<count {
        vn_string_free(typed[i].name)
    }
    typed.deinitialize(count: count)
    typed.deallocate()
}

// MARK: - 3D human body pose (macOS 14+)

@frozen
public struct VNHumanJoint3DRaw {
    public var name: UnsafeMutablePointer<CChar>?
    public var x: Float
    public var y: Float
    public var z: Float
    public var confidence: Float
    public var local_x: Float
    public var local_y: Float
    public var local_z: Float
    public var parent_joint: UnsafeMutablePointer<CChar>?
}

@_cdecl("vn_detect_human_body_pose_3d_in_path")
public func vn_detect_human_body_pose_3d_in_path(
    _ path: UnsafePointer<CChar>,
    _ out_joints_raw: UnsafeMutableRawPointer,
    _ out_count: UnsafeMutablePointer<Int>,
    _ outErrorMessage: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
    let out_joints = out_joints_raw.assumingMemoryBound(to: UnsafeMutablePointer<VNHumanJoint3DRaw>?.self)
    out_joints.pointee = nil
    out_count.pointee = 0
    if #available(macOS 14.0, *) {
        let p = String(cString: path)
        guard let img = loadCGImage(path: p) else {
            outErrorMessage?.pointee = ffiString("could not load image at \(p)")
            return VN_IMAGE_LOAD_FAILED
        }
        let req = VNDetectHumanBodyPose3DRequest()
        let handler = VNImageRequestHandler(cgImage: img, options: [:])
        do { try handler.perform([req]) } catch {
            outErrorMessage?.pointee = ffiString("3D body pose request failed: \(error.localizedDescription)")
            return VN_REQUEST_FAILED
        }
        guard let obs = req.results?.first else { return VN_OK }
        let names: [VNHumanBodyPose3DObservation.JointName] = [
            .root, .topHead, .centerHead,
            .leftShoulder, .leftElbow, .leftWrist,
            .rightShoulder, .rightElbow, .rightWrist,
            .leftHip, .leftKnee, .leftAnkle,
            .rightHip, .rightKnee, .rightAnkle,
            .spine, .centerShoulder,
        ]
        var joints: [VNHumanJoint3DRaw] = []
        for n in names {
            guard let pt = try? obs.recognizedPoint(n) else { continue }
            let pos = pt.position
            let local = pt.localPosition
            joints.append(VNHumanJoint3DRaw(
                name: ffiString(n.rawValue.rawValue),
                x: pos.columns.3.x, y: pos.columns.3.y, z: pos.columns.3.z,
                confidence: 1.0,
                local_x: local.columns.3.x,
                local_y: local.columns.3.y,
                local_z: local.columns.3.z,
                parent_joint: ffiString(pt.parentJoint.rawValue.rawValue)
            ))
        }
        if joints.isEmpty { return VN_OK }
        let buf = UnsafeMutablePointer<VNHumanJoint3DRaw>.allocate(capacity: joints.count)
        buf.initialize(from: &joints, count: joints.count)
        out_joints.pointee = buf
        out_count.pointee = joints.count
        return VN_OK
    }
    return VN_REQUEST_FAILED
}

@_cdecl("vn_human_joints_3d_free")
public func vn_human_joints_3d_free(_ ptr: UnsafeMutableRawPointer?, _ count: Int) {
    guard let ptr = ptr else { return }
    let typed = ptr.assumingMemoryBound(to: VNHumanJoint3DRaw.self)
    for i in 0..<count {
        vn_string_free(typed[i].name)
        vn_string_free(typed[i].parent_joint)
    }
    typed.deinitialize(count: count)
    typed.deallocate()
}
