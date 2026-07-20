// Pose and contour bridges.

import AppKit
import CoreGraphics
import CoreImage
import CoreML
import CoreVideo
import Foundation
import ImageIO
import Vision

// MARK: - Human body pose (v0.7)

private func bboxFromPoints(xs: [Double], ys: [Double]) -> CGRect {
    guard !xs.isEmpty else { return .zero }
    var minX = xs[0], maxX = xs[0], minY = ys[0], maxY = ys[0]
    for k in 1..<xs.count {
        if xs[k] < minX { minX = xs[k] }
        if xs[k] > maxX { maxX = xs[k] }
        if ys[k] < minY { minY = ys[k] }
        if ys[k] > maxY { maxY = ys[k] }
    }
    return CGRect(x: minX, y: minY, width: maxX - minX, height: maxY - minY)
}

@frozen
public struct VNPoseObservationRaw {
    public var bbox_x: Double
    public var bbox_y: Double
    public var bbox_w: Double
    public var bbox_h: Double
    public var confidence: Float
    // Parallel arrays of length joint_count.
    public var joint_names: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
    public var joint_xs: UnsafeMutablePointer<Double>?
    public var joint_ys: UnsafeMutablePointer<Double>?
    public var joint_confidences: UnsafeMutablePointer<Float>?
    public var joint_count: Int
}

private func emitPoseJoints(
    names: [String], xs: [Double], ys: [Double], confs: [Float]
) -> (
    UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>,
    UnsafeMutablePointer<Double>,
    UnsafeMutablePointer<Double>,
    UnsafeMutablePointer<Float>,
    Int
) {
    let n = names.count
    let nb = UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>.allocate(capacity: n)
    let xb = UnsafeMutablePointer<Double>.allocate(capacity: n)
    let yb = UnsafeMutablePointer<Double>.allocate(capacity: n)
    let cb = UnsafeMutablePointer<Float>.allocate(capacity: n)
    for i in 0..<n {
        nb[i] = strdup(names[i])
        xb[i] = xs[i]
        yb[i] = ys[i]
        cb[i] = confs[i]
    }
    return (nb, xb, yb, cb, n)
}

@_cdecl("vn_detect_human_body_pose_in_path")
public func vn_detect_human_body_pose_in_path(
    _ path: UnsafePointer<CChar>,
    _ outArray: UnsafeMutablePointer<UnsafeMutableRawPointer?>,
    _ outCount: UnsafeMutablePointer<Int>,
    _ outErrorMessage: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
    let pathStr = String(cString: path)
    guard let cgImage = loadCGImage(path: pathStr) else {
        outErrorMessage?.pointee = ffiString("could not load image at \(pathStr)")
        outArray.pointee = nil; outCount.pointee = 0
        return VN_IMAGE_LOAD_FAILED
    }
    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    let request = VNDetectHumanBodyPoseRequest()
    do { try handler.perform([request]) } catch {
        outErrorMessage?.pointee = ffiString("body-pose request failed: \(error.localizedDescription)")
        outArray.pointee = nil; outCount.pointee = 0
        return VN_REQUEST_FAILED
    }
    guard let results = request.results, !results.isEmpty else {
        outArray.pointee = nil; outCount.pointee = 0; return VN_OK
    }
    let count = results.count
    let buf = UnsafeMutablePointer<VNPoseObservationRaw>.allocate(capacity: count)
    for (i, obs) in results.enumerated() {
        var names: [String] = []
        var xs: [Double] = []
        var ys: [Double] = []
        var cs: [Float] = []
        if let points = try? obs.recognizedPoints(.all) {
            for (key, p) in points where p.confidence > 0 {
                names.append("\(key.rawValue)")
                xs.append(Double(p.location.x))
                ys.append(Double(p.location.y))
                cs.append(p.confidence)
            }
        }
        let bbox = bboxFromPoints(xs: xs, ys: ys)
        let (nb, xb, yb, cb, n) = emitPoseJoints(names: names, xs: xs, ys: ys, confs: cs)
        buf.advanced(by: i).initialize(to: VNPoseObservationRaw(
            bbox_x: bbox.origin.x,
            bbox_y: bbox.origin.y,
            bbox_w: bbox.size.width,
            bbox_h: bbox.size.height,
            confidence: obs.confidence,
            joint_names: nb, joint_xs: xb, joint_ys: yb,
            joint_confidences: cb, joint_count: n
        ))
    }
    outArray.pointee = UnsafeMutableRawPointer(buf)
    outCount.pointee = count
    return VN_OK
}

@_cdecl("vn_detect_human_hand_pose_in_path")
public func vn_detect_human_hand_pose_in_path(
    _ path: UnsafePointer<CChar>,
    _ maxHands: Int,
    _ outArray: UnsafeMutablePointer<UnsafeMutableRawPointer?>,
    _ outCount: UnsafeMutablePointer<Int>,
    _ outErrorMessage: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
    let pathStr = String(cString: path)
    guard let cgImage = loadCGImage(path: pathStr) else {
        outErrorMessage?.pointee = ffiString("could not load image at \(pathStr)")
        outArray.pointee = nil; outCount.pointee = 0
        return VN_IMAGE_LOAD_FAILED
    }
    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    let request = VNDetectHumanHandPoseRequest()
    if maxHands > 0 { request.maximumHandCount = maxHands }
    do { try handler.perform([request]) } catch {
        outErrorMessage?.pointee = ffiString("hand-pose request failed: \(error.localizedDescription)")
        outArray.pointee = nil; outCount.pointee = 0
        return VN_REQUEST_FAILED
    }
    guard let results = request.results, !results.isEmpty else {
        outArray.pointee = nil; outCount.pointee = 0; return VN_OK
    }
    let count = results.count
    let buf = UnsafeMutablePointer<VNPoseObservationRaw>.allocate(capacity: count)
    for (i, obs) in results.enumerated() {
        var names: [String] = []
        var xs: [Double] = []
        var ys: [Double] = []
        var cs: [Float] = []
        if let points = try? obs.recognizedPoints(.all) {
            for (key, p) in points where p.confidence > 0 {
                names.append("\(key.rawValue)")
                xs.append(Double(p.location.x))
                ys.append(Double(p.location.y))
                cs.append(p.confidence)
            }
        }
        let bbox = bboxFromPoints(xs: xs, ys: ys)
        let (nb, xb, yb, cb, n) = emitPoseJoints(names: names, xs: xs, ys: ys, confs: cs)
        buf.advanced(by: i).initialize(to: VNPoseObservationRaw(
            bbox_x: bbox.origin.x,
            bbox_y: bbox.origin.y,
            bbox_w: bbox.size.width,
            bbox_h: bbox.size.height,
            confidence: obs.confidence,
            joint_names: nb, joint_xs: xb, joint_ys: yb,
            joint_confidences: cb, joint_count: n
        ))
    }
    outArray.pointee = UnsafeMutableRawPointer(buf)
    outCount.pointee = count
    return VN_OK
}

@_cdecl("vn_pose_observations_free")
public func vn_pose_observations_free(_ array: UnsafeMutableRawPointer?, _ count: Int) {
    guard let array = array else { return }
    let typed = array.assumingMemoryBound(to: VNPoseObservationRaw.self)
    for i in 0..<count {
        let r = typed.advanced(by: i).pointee
        if let nb = r.joint_names {
            for j in 0..<r.joint_count { if let s = nb[j] { free(s) } }
            nb.deallocate()
        }
        r.joint_xs?.deallocate()
        r.joint_ys?.deallocate()
        r.joint_confidences?.deallocate()
    }
    typed.deallocate()
}

// MARK: - Contours

@frozen
public struct VNContourRaw {
    public var point_xs: UnsafeMutablePointer<Double>?
    public var point_ys: UnsafeMutablePointer<Double>?
    public var point_count: Int
    public var child_count: Int
    public var aspect_ratio: Float
}

@_cdecl("vn_detect_contours_in_path")
public func vn_detect_contours_in_path(
    _ path: UnsafePointer<CChar>,
    _ contrastAdjustment: Float,
    _ detectsDarkOnLight: Bool,
    _ outArray: UnsafeMutablePointer<UnsafeMutableRawPointer?>,
    _ outCount: UnsafeMutablePointer<Int>,
    _ outErrorMessage: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
    let pathStr = String(cString: path)
    guard let cgImage = loadCGImage(path: pathStr) else {
        outErrorMessage?.pointee = ffiString("could not load image at \(pathStr)")
        outArray.pointee = nil; outCount.pointee = 0
        return VN_IMAGE_LOAD_FAILED
    }
    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    let request = VNDetectContoursRequest()
    request.contrastAdjustment = contrastAdjustment
    request.detectsDarkOnLight = detectsDarkOnLight
    do { try handler.perform([request]) } catch {
        outErrorMessage?.pointee = ffiString("contour request failed: \(error.localizedDescription)")
        outArray.pointee = nil; outCount.pointee = 0
        return VN_REQUEST_FAILED
    }
    guard let results = request.results, let observation = results.first else {
        outArray.pointee = nil; outCount.pointee = 0; return VN_OK
    }
    let top = observation.topLevelContours
    let count = top.count
    if count == 0 { outArray.pointee = nil; outCount.pointee = 0; return VN_OK }
    let buf = UnsafeMutablePointer<VNContourRaw>.allocate(capacity: count)
    for (i, contour) in top.enumerated() {
        let pts = contour.normalizedPoints
        let n = pts.count
        let xb = UnsafeMutablePointer<Double>.allocate(capacity: n)
        let yb = UnsafeMutablePointer<Double>.allocate(capacity: n)
        for k in 0..<n {
            xb[k] = Double(pts[k].x)
            yb[k] = Double(pts[k].y)
        }
        buf.advanced(by: i).initialize(to: VNContourRaw(
            point_xs: xb, point_ys: yb, point_count: n,
            child_count: contour.childContourCount,
            aspect_ratio: contour.aspectRatio
        ))
    }
    outArray.pointee = UnsafeMutableRawPointer(buf)
    outCount.pointee = count
    return VN_OK
}

@_cdecl("vn_contours_free")
public func vn_contours_free(_ array: UnsafeMutableRawPointer?, _ count: Int) {
    guard let array = array else { return }
    let typed = array.assumingMemoryBound(to: VNContourRaw.self)
    for i in 0..<count {
        let r = typed.advanced(by: i).pointee
        r.point_xs?.deallocate()
        r.point_ys?.deallocate()
    }
    typed.deallocate()
}
