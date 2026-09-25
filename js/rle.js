// RLE map decode - faithful port of the app's RLEUtil.kt (o5/i.java).
(function (global) {
  'use strict';

  // data: Uint8Array of the base64-decoded map_data. Returns Uint8Array grid.
  function decodeRLE(data) {
    if (!data || data.length < 9) return null;
    if (String.fromCharCode(data[0], data[1], data[2]) !== 'RLE') return null;

    let marker = data[3];       // run-marker byte
    let prev = data[4];         // prev byte
    let pos = 5;
    let outLen = 0;
    for (let k = 0; k < 4; k++) { outLen = (outLen << 8) | (data[pos++] & 255); }

    const out = new Uint8Array(outLen);
    let oi = 0;

    while (pos < data.length) {
      let b12 = data[pos];
      let count = 1;
      if (b12 === marker) {
        // marker byte encountered
        if (data[pos + 1] === 0) {
          // escape: marker followed by 0 -> next byte is a literal marker value
          pos += 2;
          if (prev === data[pos]) {
            // literal equals prev byte: swap meaning of marker/prev
            pos += 1;
            const tmp = prev;
            prev = marker;
            marker = data[pos - 1];
            b12 = tmp;
          } else {
            b12 = data[pos];
            pos += 1;
            count = 1;
          }
        } else {
          // normal run: marker, count, value
          count = data[pos + 1] & 255;
          b12 = data[pos + 2];
          pos += 3;
        }
      } else {
        pos += 1;
      }
      while (count > 0 && oi < outLen) {
        out[oi++] = b12;
        count--;
      }
    }
    return out;
  }

  // Decode the full payload of an ENTIRE / tile map message.
  // JSON: { "real_x": float, "real_y": float, "dimension_x": int,
  //         "dimension_y": int, "resolution": float, "map_data": base64 }
  function decodeMapMessage(json) {
    const bytes = base64ToBytes(json.map_data);
    const grid = decodeRLE(bytes);
    if (!grid) return null;
    const dimX = json.dimension_x, dimY = json.dimension_y;
    if (dimX * dimY !== grid.length) {
      // Fallback: some payloads are a row-of-rows; just render as-is.
      return { grid, dimX, dimY: Math.max(1, Math.round(grid.length / Math.max(1, dimX))),
               res: json.resolution, realX: json.real_x, realY: json.real_y };
    }
    return { grid, dimX, dimY, res: json.resolution, realX: json.real_x, realY: json.real_y };
  }

  function base64ToBytes(b64) {
    if (typeof atob !== 'undefined') {
      const bin = atob(b64);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    // node path (unused in browser)
    const BufferImpl = global.Buffer;
    return new Uint8Array(BufferImpl.from(b64, 'base64'));
  }

  // Cell colors (from the app's map renderer):
  //   0      -> unknown/transparent
  //   1..127 -> free (white)
  //   >127   -> obstacle (dark gray)
  function cellToColor(v) {
    if (v === 0) return 'rgba(0,0,0,0)';
    if (v > 127) return '#2a3142';
    return '#eef1f6';
  }

  global.MapRLE = { decodeRLE, decodeMapMessage, base64ToBytes, cellToColor };
})(window);