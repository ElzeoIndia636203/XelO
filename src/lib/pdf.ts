const MAX_PDF_BYTES = 2 * 1024 * 1024;

export async function pdfToText(file: File): Promise<string> {
  if (file.size > MAX_PDF_BYTES) {
    throw new Error('pdf_too_large');
  }
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';

  const buffer = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: buffer }).promise;
  const pages: string[] = [];

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const strings = content.items
      .map((item) => ('str' in item && typeof item.str === 'string' ? item.str : ''))
      .filter(Boolean);
    pages.push(strings.join(' '));
  }

  return pages.join('\n\n').trim();
}
