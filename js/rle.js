// RLE map decode - faithful port of the app's RLEUtil.kt (o5/i.java).
(function (global) {
  'use strict';

  // data: Uint8Array of the base64-decoded map_data. Returns Uint8Array grid.
  // Port of RLEUtil.kt (o5/i.java), verified against live robot maps:
  //   full map 174x173 -> len field 30102 = 174*173 (decodes to EXACTLY 30102).
  //
  // Format: "RLE", marker, prev, then 4-byte LITTLE-ENDIAN decompressed length,
  // then a token stream:
  //   * normal run  : <marker> <count> <value>  -> emit `value` `count` times
  //   * literal byte: any non-marker byte        -> emit it once
  //   * escape      : <marker> 0x00 <x>          -> emit NOTHING; if prev === x,
  //                   swap marker/prev (marker = x); consumes all three bytes.
  // The escape is a pure control token: emitting a byte here corrupts the grid
  // (this was the root cause of the "garbage map"). Length field caps output.
  function decodeRLE(data) {
    if (!data || data.length < 9) return null;
    if (String.fromCharCode(data[0], data[1], data[2]) !== 'RLE') return null;

    let marker = data[3];       // run-marker byte
    let prev = data[4];         // prev byte
    let pos = 5;
    let outLen = 0;
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
          // escape control token: emits nothing, advances past the compared byte
          i13++;
          if (i13 >= n) break;
          if (prev === data[i13]) {
            prev = marker;
            marker = data[i13];
          }
          i13++;
          j12 = 0;
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

  // Known-answer self test so we can prove at runtime whether the *loaded*
  // decoder is correct (catches stale caches serving an old rle.js).
  function selfTest() {
    // (1) simple: "RLE", marker=0x81, prev=0x7f, outLen=3 (LE),
    //     run(marker,2,0x05), literal 0x07  -> [5,5,7]
    // (2) escape: exercises the <marker>0x00<x> control token, which MUST emit
    //     nothing and swap marker/prev -> [65,65,66,66,66]
    const vectors = [
      { b64: 'UkxFgX8DAAAAgQIFBw==', want: [5, 5, 7] },
      { b64: 'UkxFgX8FAAAAgQJBgQB/fwNC', want: [65, 65, 66, 66, 66] },
    ];
    try {
      for (const v of vectors) {
        const g = decodeRLE(base64ToBytes(v.b64));
        if (!g) return { ok: false, detail: 'decode returned null' };
        if (g.length !== v.want.length) return { ok: false, detail: 'len=' + g.length + ' want ' + v.want.length };
        for (let i = 0; i < v.want.length; i++) {
          if (g[i] !== v.want[i]) return { ok: false, detail: '[' + Array.from(g).join(',') + '] want [' + v.want.join(',') + ']' };
        }
      }
      return { ok: true, detail: '2 vectors pass' };
    } catch (e) {
      return { ok: false, detail: 'threw ' + (e && e.message) };
    }
  }

  const VER = 'rle26';
  global.MapRLE = { VER, decodeRLE, decodeMapMessage, base64ToBytes, cellToColor, selfTest };
})(window);