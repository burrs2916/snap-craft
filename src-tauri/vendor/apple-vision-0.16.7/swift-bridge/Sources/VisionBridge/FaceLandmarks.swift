// Face-landmark bridge backed by VNDetectFaceLandmarksRequest.

import AppKit
import CoreGraphics
import CoreImage
import CoreML
import CoreVideo
import Foundation
import ImageIO
import Vision

// MARK: - Face landmarks (v0.6)

/// One face + its detected landmarks. All point buffers are
/// normalised in 0..1 image coordinates (Vision convention; bottom-left
/// origin) and stored as `[x0, y0, x1, y1, …]` interleaved doubles.
/// Each `*_count` is the number of POINTS (not doubles).
/// A NULL pointer + 0 count means the region wasn't detected.
@frozen
public struct VNFaceLandmarksRaw {
    public var bbox_x: Double
    public var bbox_y: Double
    public var bbox_w: Double
    public var bbox_h: Double
    public var confidence: Float
    public var roll: Float
    public var yaw: Float
    public var pitch: Float

    public var face_contour: UnsafeMutablePointer<Double>?
    public var face_contour_count: Int
    public var left_eye: UnsafeMutablePointer<Double>?
    public var left_eye_count: Int
    public var right_eye: UnsafeMutablePointer<Double>?
    public var right_eye_count: Int
    public var left_eyebrow: UnsafeMutablePointer<Double>?
    public var left_eyebrow_count: Int
    public var right_eyebrow: UnsafeMutablePointer<Double>?
    public var right_eyebrow_count: Int
    public var nose: UnsafeMutablePointer<Double>?
    public var nose_count: Int
    public var nose_crest: UnsafeMutablePointer<Double>?
    public var nose_crest_count: Int
    public var median_line: UnsafeMutablePointer<Double>?
    public var median_line_count: Int
    public var outer_lips: UnsafeMutablePointer<Double>?
    public var outer_lips_count: Int
    public var inner_lips: UnsafeMutablePointer<Double>?
    public var inner_lips_count: Int
    public var left_pupil: UnsafeMutablePointer<Double>?
    public var left_pupil_count: Int
    public var right_pupil: UnsafeMutablePointer<Double>?
    public var right_pupil_count: Int
}

private func copyRegion(_ region: VNFaceLandmarkRegion2D?)
    -> (UnsafeMutablePointer<Double>?, Int)
{
    guard let region = region, region.pointCount > 0 else { return (nil, 0) }
    let n = region.pointCount
    let buf = UnsafeMutablePointer<Double>.allocate(capacity: n * 2)
    let pts = region.normalizedPoints
    for i in 0..<n {
        buf[i * 2] = Double(pts[i].x)
        buf[i * 2 + 1] = Double(pts[i].y)
    }
    return (buf, n)
}

@_cdecl("vn_detect_face_landmarks_in_path")
public func vn_detect_face_landmarks_in_path(
    _ path: UnsafePointer<CChar>,
    _ outArray: UnsafeMutablePointer<UnsafeMutableRawPointer?>,
    _ outCount: UnsafeMutablePointer<Int>,
    _ outErrorMessage: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
    let pathStr = String(cString: path)
    guard let cgImage = loadCGImage(path: pathStr) else {
        outErrorMessage?.pointee = ffiString("could not load image at \(pathStr)")
        outArray.pointee = nil
        outCount.pointee = 0
        return VN_IMAGE_LOAD_FAILED
    }
    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    let request = VNDetectFaceLandmarksRequest()
    do {
        try handler.perform([request])
    } catch {
        outErrorMessage?.pointee = ffiString(
            "VNImageRequestHandler.perform(face-landmarks) failed: \(error.localizedDescription)"
        )
        outArray.pointee = nil
        outCount.pointee = 0
        return VN_REQUEST_FAILED
    }
    guard let results = request.results, !results.isEmpty else {
        outArray.pointee = nil
        outCount.pointee = 0
        return VN_OK
    }
    let count = results.count
    let buffer = UnsafeMutablePointer<VNFaceLandmarksRaw>.allocate(capacity: count)
    for (i, observation) in results.enumerated() {
        let bbox = observation.boundingBox
        let l = observation.landmarks
        let (fc, fcN) = copyRegion(l?.faceContour)
        let (le, leN) = copyRegion(l?.leftEye)
        let (re, reN) = copyRegion(l?.rightEye)
        let (leb, lebN) = copyRegion(l?.leftEyebrow)
        let (reb, rebN) = copyRegion(l?.rightEyebrow)
        let (nose, noseN) = copyRegion(l?.nose)
        let (nc, ncN) = copyRegion(l?.noseCrest)
        let (ml, mlN) = copyRegion(l?.medianLine)
        let (ol, olN) = copyRegion(l?.outerLips)
        let (il, ilN) = copyRegion(l?.innerLips)
        let (lp, lpN) = copyRegion(l?.leftPupil)
        let (rp, rpN) = copyRegion(l?.rightPupil)
        buffer.advanced(by: i).initialize(to: VNFaceLandmarksRaw(
            bbox_x: Double(bbox.origin.x),
            bbox_y: Double(bbox.origin.y),
            bbox_w: Double(bbox.size.width),
            bbox_h: Double(bbox.size.height),
            confidence: observation.confidence,
            roll: observation.roll?.floatValue ?? .nan,
            yaw: observation.yaw?.floatValue ?? .nan,
            pitch: observation.pitch?.floatValue ?? .nan,
            face_contour: fc, face_contour_count: fcN,
            left_eye: le, left_eye_count: leN,
            right_eye: re, right_eye_count: reN,
            left_eyebrow: leb, left_eyebrow_count: lebN,
            right_eyebrow: reb, right_eyebrow_count: rebN,
            nose: nose, nose_count: noseN,
            nose_crest: nc, nose_crest_count: ncN,
            median_line: ml, median_line_count: mlN,
            outer_lips: ol, outer_lips_count: olN,
            inner_lips: il, inner_lips_count: ilN,
            left_pupil: lp, left_pupil_count: lpN,
            right_pupil: rp, right_pupil_count: rpN
        ))
    }
    outArray.pointee = UnsafeMutableRawPointer(buffer)
    outCount.pointee = count
    return VN_OK
}

@_cdecl("vn_face_landmarks_free")
public func vn_face_landmarks_free(_ array: UnsafeMutableRawPointer?, _ count: Int) {
    guard let array = array else { return }
    let typed = array.assumingMemoryBound(to: VNFaceLandmarksRaw.self)
    for i in 0..<count {
        let face = typed.advanced(by: i).pointee
        face.face_contour?.deallocate()
        face.left_eye?.deallocate()
        face.right_eye?.deallocate()
        face.left_eyebrow?.deallocate()
        face.right_eyebrow?.deallocate()
        face.nose?.deallocate()
        face.nose_crest?.deallocate()
        face.median_line?.deallocate()
        face.outer_lips?.deallocate()
        face.inner_lips?.deallocate()
        face.left_pupil?.deallocate()
        face.right_pupil?.deallocate()
    }
    typed.deallocate()
}
