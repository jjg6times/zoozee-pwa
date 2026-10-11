// RLE map decode - faithful port of the app's RLEUtil.kt (o5/i.java).
(function (global) {
  'use strict';

  // data: Uint8Array of the base64-decoded map_data. Returns Uint8Array grid.
  // Faithful port of RLEUtil.kt (o5/i.java), verified against live robot maps:
  //   full map 131x149 -> len field 19519 = 131*149; tile 54x80 -> 4320 = 54*80.
  function decodeRLE(data) {
    if (!data || data.length < 9) return null;
    if (String.fromCharCode(data[0], data[1], data[2]) !== 'RLE') return null;

    let marker = data[3];       // run-marker byte
    let prev = data[4];         // prev byte
    let pos = 5;
    let outLen = 0;
    // Decompressed length is a 4-byte LITTLE-ENDIAN integer, and is used as the
    // output cap (the token stream may encode a little more than one map).
    for (let k = 0; k < 4; k++) { outLen += (data[pos++] & 255) * (2 ** (8 * k)); }
    if (outLen < 0 || outLen > 50e6) return null; // sanity guard

    const out = new Uint8Array(outLen);
    let oi = 0;
    const n = data.length;

    while (pos < n) {
      let i13 = pos + 1;
      let b12 = data[pos];
      let j12 = 1;
      if (b12 === marker) {
        if (i13 >= n) break;
        if (data[i13] === 0) {
          // escape: marker followed by 0 -> next byte decides marker/prev swap
          i13++;
          if (i13 >= n) break;
          if (prev === data[i13]) {
            prev = marker;
            marker = data[i13];
          }
        } else {
          // normal run: marker, count, value
          const i14 = i13 + 1;
          if (i14 >= n) break;
          j12 = data[i13] & 255;
          i13 = i14 + 1;
          b12 = data[i14];
        }
      }
      while (j12 > 0 && oi < outLen) {
        out[oi++] = b12;
        j12--;
      }
      pos = i13;
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