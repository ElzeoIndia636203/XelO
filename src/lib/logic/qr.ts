import qrcode from 'qrcode-generator';

export function verificationCode(courseCode: string, rollNo: string, studentId: string): string {
  const cleanCourse = courseCode.toUpperCase().replace(/[^A-Z0-9]/g, '') || 'LAB';
  const cleanRoll = rollNo.trim() || studentId.slice(0, 6);
  // Deterministic 16-bit FNV-1a checksum displayed as 4 uppercase hex chars for UI preview;
  // server verify_lab_file uses SHA-256 over course_id:student_id.
  let h = 2166136261;
  const input = `${cleanCourse}:${studentId}`;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const hex4 = ((h >>> 0) & 0xffff).toString(16).toUpperCase().padStart(4, '0');
  return `XO-${cleanCourse}-${cleanRoll}-${hex4}`;
}

export function qrSvgData(payload: string): { size: number; path: string } {
  const qr = qrcode(0, 'M');
  qr.addData(payload);
  qr.make();
  const size = qr.getModuleCount();
  const parts: string[] = [];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (qr.isDark(r, c)) {
        parts.push(`M${c},${r}h1v1h-1z`);
      }
    }
  }
  return { size, path: parts.join('') };
}
