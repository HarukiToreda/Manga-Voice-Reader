// Runs `comic-text-detector` (github.com/dmMaze/comic-text-detector), a
// YOLOv5-style text-*block* detector trained on ~13k real manga/comic pages
// (Manga109-s + Digital Comic Museum + synthetic), as a second detection
// pass alongside PaddleOCR's own general-document-trained detector.
//
// Why this exists: a full-chapter manual audit (screenshots checked directly
// against PaddleOCR's raw detection output, not just the filtered/spoken
// text) found real, repeated cases where PaddleOCR's detector found *zero*
// trace of clearly-legible dialogue — both in panels with dense diagonal
// speed-line/motion-blur art (its region-proposal step apparently confused
// by the surrounding ink density) and, more surprisingly, in some ordinary
// panels with plain round bubbles. Confirmed directly against this same
// model: it found all 6 of the real bubbles from that audit that PaddleOCR
// missed entirely (cropped and visually verified each one), because it's
// trained on the actual visual distribution this project needs — comic
// line art and lettering — instead of documents/scene text.
//
// Detection-only: this model finds *where* text blocks are (whole-bubble
// boxes, not per-word), not what they say. offscreen.js crops each detected
// block and still runs PaddleOCR's own recognize() on that crop — which
// keeps working fine here because a small, isolated crop gives PaddleOCR's
// own detector an easy, uncluttered job, unlike the full noisy page.

const INPUT_SIZE = 1024; // fixed square input the model was exported for
const CONF_THRESH = 0.3; // below this, boxes are more often noise (motion-line clutter) than real text
const NMS_THRESH = 0.35; // matches the reference Python implementation

// Resizes the source canvas into a 1024x1024 letterboxed (aspect-preserved,
// gray-padded) square and returns both the CHW float32 tensor data the model
// expects and the scale/offset needed to map its output boxes back to the
// original canvas's coordinate space.
function letterboxToTensor(sourceCanvas) {
  const w0 = sourceCanvas.width;
  const h0 = sourceCanvas.height;
  const scale = Math.min(INPUT_SIZE / w0, INPUT_SIZE / h0);
  const newW = Math.round(w0 * scale);
  const newH = Math.round(h0 * scale);
  const padLeft = Math.floor((INPUT_SIZE - newW) / 2);
  const padTop = Math.floor((INPUT_SIZE - newH) / 2);

  const canvas = new OffscreenCanvas(INPUT_SIZE, INPUT_SIZE);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgb(114,114,114)'; // YOLOv5's conventional letterbox fill
  ctx.fillRect(0, 0, INPUT_SIZE, INPUT_SIZE);
  ctx.drawImage(sourceCanvas, 0, 0, w0, h0, padLeft, padTop, newW, newH);

  const { data } = ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE);
  const plane = INPUT_SIZE * INPUT_SIZE;
  const chw = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    const o = i * 4;
    chw[i] = data[o] / 255; // R
    chw[plane + i] = data[o + 1] / 255; // G
    chw[2 * plane + i] = data[o + 2] / 255; // B
  }
  return { chw, scale, padLeft, padTop };
}

function iou(a, b) {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]);
  const y2 = Math.min(a[3], b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const areaA = (a[2] - a[0]) * (a[3] - a[1]);
  const areaB = (b[2] - b[0]) * (b[3] - b[1]);
  return inter / (areaA + areaB - inter + 1e-9);
}

function nms(boxes, thresh) {
  boxes.sort((a, b) => b.conf - a.conf);
  const kept = [];
  for (const box of boxes) {
    if (kept.every((k) => iou(k.xyxy, box.xyxy) < thresh)) kept.push(box);
  }
  return kept;
}

// blk: raw [1, N, 7] tensor — cx,cy,w,h,objectness,cls0,cls1 per anchor
// (standard pre-NMS YOLOv5 head output). Returns boxes in the *original*
// (pre-letterbox) canvas's coordinate space, clamped to its bounds.
function decodeBlocks(blkTensor, w0, h0, scale, padLeft, padTop) {
  const arr = blkTensor.data;
  const stride = blkTensor.dims[2];
  const n = blkTensor.dims[1];
  const candidates = [];
  for (let i = 0; i < n; i++) {
    const o = i * stride;
    const obj = arr[o + 4];
    const cls0 = arr[o + 5];
    const cls1 = arr[o + 6];
    const conf = obj * Math.max(cls0, cls1);
    if (conf < CONF_THRESH) continue;
    const cx = arr[o];
    const cy = arr[o + 1];
    const bw = arr[o + 2];
    const bh = arr[o + 3];
    const x1 = (cx - bw / 2 - padLeft) / scale;
    const y1 = (cy - bh / 2 - padTop) / scale;
    const x2 = (cx + bw / 2 - padLeft) / scale;
    const y2 = (cy + bh / 2 - padTop) / scale;
    candidates.push({
      xyxy: [Math.max(0, x1), Math.max(0, y1), Math.min(w0, x2), Math.min(h0, y2)],
      conf,
    });
  }
  return nms(candidates, NMS_THRESH);
}

// session: an onnxruntime-web InferenceSession already loaded with
// comic-text-detector.onnx. sourceCanvas: the full captured screenshot.
// Returns an array of { xyxy: [x1,y1,x2,y2], conf } text-block boxes in
// sourceCanvas's own coordinate space.
async function detectBlocks(session, Tensor, sourceCanvas) {
  const { chw, scale, padLeft, padTop } = letterboxToTensor(sourceCanvas);
  const tensor = new Tensor('float32', chw, [1, 3, INPUT_SIZE, INPUT_SIZE]);
  const results = await session.run({ images: tensor });
  return decodeBlocks(results.blk, sourceCanvas.width, sourceCanvas.height, scale, padLeft, padTop);
}

const MVR_COMIC_DETECTOR = { detectBlocks };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = MVR_COMIC_DETECTOR;
} else {
  (typeof window !== 'undefined' ? window : globalThis).MVR_COMIC_DETECTOR = MVR_COMIC_DETECTOR;
}
