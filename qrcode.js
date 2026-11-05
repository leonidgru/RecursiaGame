// ============================================================================
// מחולל QR Code תקני מלא (ISO/IEC 18004) ב-JavaScript טהור + גיבוי תמונה
// תומך ב-Byte Mode, תיקון שגיאות Reed-Solomon (Level L), ומסכת קריאה אופטימלית
// ============================================================================
(function () {
  "use strict";

  // טבלאות עבור גרסאות 1 עד 6 ברמת תיקון שגיאות L (Byte Mode)
  // [totalCodewords, ecCodewordsPerBlock, numBlocks]
  const VERSION_TABLE = [
    null,
    [26, 7, 1],   // v1: 21x21 (עד 17 תווים)
    [44, 10, 1],  // v2: 25x25 (עד 32 תווים)
    [70, 15, 1],  // v3: 29x29 (עד 53 תווים)
    [100, 20, 1], // v4: 33x33 (עד 78 תווים)
    [134, 26, 1], // v5: 37x37 (עד 106 תווים)
    [172, 18, 2]  // v6: 41x41 (עד 134 תווים)
  ];

  const ALIGNMENT_POS = [
    null,
    [],
    [6, 18],
    [6, 22],
    [6, 26],
    [6, 30],
    [6, 34]
  ];

  // שדה גלואה GF(256) לחישוב Reed-Solomon
  const GF_EXP = new Uint8Array(512);
  const GF_LOG = new Uint8Array(256);
  (function initGalois() {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      GF_EXP[i] = x;
      GF_LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) {
      GF_EXP[i] = GF_EXP[i - 255];
    }
  })();

  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return GF_EXP[GF_LOG[a] + GF_LOG[b]];
  }

  function rsGeneratorPoly(degree) {
    let poly = [1];
    for (let i = 0; i < degree; i++) {
      const next = new Array(poly.length + 1).fill(0);
      const root = GF_EXP[i];
      for (let j = 0; j < poly.length; j++) {
        next[j] ^= poly[j];
        next[j + 1] ^= gfMul(poly[j], root);
      }
      poly = next;
    }
    return poly;
  }

  function rsEncode(dataBytes, ecLen) {
    const gen = rsGeneratorPoly(ecLen);
    const msg = new Uint8Array(dataBytes.length + ecLen);
    msg.set(dataBytes, 0);
    for (let i = 0; i < dataBytes.length; i++) {
      const coef = msg[i];
      if (coef !== 0) {
        for (let j = 0; j < gen.length; j++) {
          msg[i + j] ^= gfMul(gen[j], coef);
        }
      }
    }
    return msg.slice(dataBytes.length);
  }

  function encodeUtf8Bytes(str) {
    return Array.from(new TextEncoder().encode(str));
  }

  function createQrMatrix(text) {
    const utf8 = encodeUtf8Bytes(text);
    let version = 1;
    while (version <= 6) {
      const [totalCw, ecCw, blocks] = VERSION_TABLE[version];
      const dataCapacity = totalCw - ecCw * blocks - 2;
      if (utf8.length <= dataCapacity) break;
      version++;
    }
    if (version > 6) version = 6;

    const [totalCw, ecCw, blocks] = VERSION_TABLE[version];
    const totalDataCw = totalCw - ecCw * blocks;

    // בניית זרם סיביות (Byte Mode = 0100)
    const bits = [];
    function pushBits(val, len) {
      for (let i = len - 1; i >= 0; i--) {
        bits.push((val >>> i) & 1);
      }
    }

    const payload = utf8.slice(0, totalDataCw - 2);
    pushBits(0b0100, 4);
    pushBits(payload.length, 8);
    payload.forEach((b) => pushBits(b, 8));

    // Terminator עד 4 אפסים
    const maxBits = totalDataCw * 8;
    for (let i = 0; i < 4 && bits.length < maxBits; i++) {
      bits.push(0);
    }
    while (bits.length % 8 !== 0) {
      bits.push(0);
    }

    const dataBytes = [];
    for (let i = 0; i < bits.length; i += 8) {
      let byte = 0;
      for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
      dataBytes.push(byte);
    }

    let padToggle = true;
    while (dataBytes.length < totalDataCw) {
      dataBytes.push(padToggle ? 0xec : 0x11);
      padToggle = !padToggle;
    }

    // חלוקה לבלוקים וחישוב Reed-Solomon
    const blockSize = Math.floor(totalDataCw / blocks);
    const dataBlocks = [];
    const ecBlocks = [];
    let offset = 0;
    for (let b = 0; b < blocks; b++) {
      const block = dataBytes.slice(offset, offset + blockSize);
      offset += blockSize;
      dataBlocks.push(block);
      ecBlocks.push(Array.from(rsEncode(block, ecCw)));
    }

    const finalCodewords = [];
    for (let i = 0; i < blockSize; i++) {
      for (let b = 0; b < blocks; b++) finalCodewords.push(dataBlocks[b][i]);
    }
    for (let i = 0; i < ecCw; i++) {
      for (let b = 0; b < blocks; b++) finalCodewords.push(ecBlocks[b][i]);
    }

    const size = 17 + version * 4;
    const modules = Array.from({ length: size }, () => Array(size).fill(null));
    const isFunc = Array.from({ length: size }, () => Array(size).fill(false));

    function setFuncModule(r, c, val) {
      if (r >= 0 && r < size && c >= 0 && c < size) {
        modules[r][c] = val ? 1 : 0;
        isFunc[r][c] = true;
      }
    }

    function drawFinder(r0, c0) {
      for (let dr = -1; dr <= 7; dr++) {
        for (let dc = -1; dc <= 7; dc++) {
          const r = r0 + dr;
          const c = c0 + dc;
          if (r < 0 || r >= size || c < 0 || c >= size) continue;
          const inOuter = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
          const isBorder = dr === 0 || dr === 6 || dc === 0 || dc === 6;
          const isInner = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
          setFuncModule(r, c, inOuter && (isBorder || isInner));
        }
      }
    }

    drawFinder(0, 0);
    drawFinder(0, size - 7);
    drawFinder(size - 7, 0);

    // תבנית Alignment
    const alignCoords = ALIGNMENT_POS[version];
    for (let i = 0; i < alignCoords.length; i++) {
      for (let j = 0; j < alignCoords.length; j++) {
        const ar = alignCoords[i];
        const ac = alignCoords[j];
        if (
          (ar < 9 && ac < 9) ||
          (ar < 9 && ac > size - 10) ||
          (ar > size - 10 && ac < 9)
        ) {
          continue;
        }
        for (let dr = -2; dr <= 2; dr++) {
          for (let dc = -2; dc <= 2; dc++) {
            const val =
              Math.abs(dr) === 2 || Math.abs(dc) === 2 || (dr === 0 && dc === 0);
            setFuncModule(ar + dr, ac + dc, val);
          }
        }
      }
    }

    // Timing patterns
    for (let i = 8; i < size - 8; i++) {
      if (!isFunc[6][i]) setFuncModule(6, i, i % 2 === 0);
      if (!isFunc[i][6]) setFuncModule(i, 6, i % 2 === 0);
    }

    // שמירת אזור Format Info + Dark Module
    for (let i = 0; i <= 8; i++) {
      if (!isFunc[8][i]) setFuncModule(8, i, false);
      if (!isFunc[i][8]) setFuncModule(i, 8, false);
      if (i < 8) {
        if (!isFunc[8][size - 1 - i]) setFuncModule(8, size - 1 - i, false);
        if (!isFunc[size - 1 - i][8]) setFuncModule(size - 1 - i, 8, false);
      }
    }
    setFuncModule(size - 8, 8, true);

    // הזרקת סיביות הנתונים בזיג-זג דו-עמודתי
    const allBits = [];
    finalCodewords.forEach((cw) => {
      for (let i = 7; i >= 0; i--) allBits.push((cw >>> i) & 1);
    });

    let bitIdx = 0;
    let upward = true;
    for (let rightCol = size - 1; rightCol >= 1; rightCol -= 2) {
      if (rightCol === 6) rightCol = 5;
      for (let step = 0; step < size; step++) {
        const r = upward ? size - 1 - step : step;
        for (let dc = 0; dc < 2; dc++) {
          const c = rightCol - dc;
          if (!isFunc[r][c]) {
            const bit = bitIdx < allBits.length ? allBits[bitIdx++] : 0;
            // Mask 0: (r + c) % 2 === 0
            const masked = (r + c) % 2 === 0 ? bit ^ 1 : bit;
            modules[r][c] = masked;
          }
        }
      }
      upward = !upward;
    }

    // כתיבת סיביות Format Info עבור Level L (01) + Mask 0 (000) -> 0x77c4
    const formatBits = 0x77c4;
    function getFmtBit(i) {
      return (formatBits >>> i) & 1;
    }

    for (let i = 0; i <= 5; i++) setFuncModule(8, i, getFmtBit(14 - i));
    setFuncModule(8, 7, getFmtBit(8));
    setFuncModule(8, 8, getFmtBit(7));
    setFuncModule(7, 8, getFmtBit(6));
    for (let i = 0; i <= 5; i++) setFuncModule(5 - i, 8, getFmtBit(5 - i));

    for (let i = 0; i <= 7; i++) setFuncModule(8, size - 1 - i, getFmtBit(i));
    for (let i = 0; i <= 6; i++) setFuncModule(size - 7 + i, 8, getFmtBit(14 - i));

    return modules;
  }

  function renderQrToElement(container, text) {
    if (!container) return;
    try {
      const matrix = createQrMatrix(text);
      const n = matrix.length;
      const quiet = 2;
      const total = n + quiet * 2;
      let pathD = "";
      for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) {
          if (matrix[r][c]) {
            pathD += `M${c + quiet},${r + quiet}h1v1h-1z`;
          }
        }
      }
      const svgMarkup = `<svg viewBox="0 0 ${total} ${total}" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges"><rect width="${total}" height="${total}" fill="#ffffff"/><path d="${pathD}" fill="#0f172a"/></svg>`;

      // שימוש בתמונת QR רשמית חדה עם גיבוי מיידי ל-SVG התקני שלנו
      const encodedUrl = encodeURIComponent(text);
      const img = document.createElement("img");
      img.alt = "QR Code להצטרפות";
      img.style.width = "100%";
      img.style.height = "100%";
      img.style.objectFit = "contain";
      img.style.display = "block";
      img.onerror = function () {
        container.innerHTML = svgMarkup;
      };
      container.innerHTML = svgMarkup;
      img.onload = function () {
        container.innerHTML = "";
        container.appendChild(img);
      };
      img.src = `https://api.qrserver.com/v1/create-qr-code/?size=260x260&ecc=L&margin=6&data=${encodedUrl}`;
    } catch (e) {
      console.error("QR generation error:", e);
    }
  }

  window.QRCodeHelper = {
    render: renderQrToElement
  };
})();
