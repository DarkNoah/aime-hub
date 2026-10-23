import { zipSync, strToU8 } from 'fflate';

const wordNs = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const relationships =
  'http://schemas.openxmlformats.org/package/2006/relationships';
const relNs =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
function archive(files: Record<string, string>) {
  return Buffer.from(
    zipSync(
      Object.fromEntries(
        Object.entries(files).map(([name, content]) => [
          name,
          strToU8(content),
        ]),
      ),
    ),
  );
}

export function documentFixture(paragraphs: string[] = ['正文内容。']) {
  const paragraph = (text: string, level?: number) =>
    `<w:p>${level ? `<w:pPr><w:pStyle w:val="Heading${level}"/></w:pPr>` : ''}<w:r><w:t>${text}</w:t></w:r></w:p>`;
  return archive({
    '[Content_Types].xml':
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    'word/document.xml': `<w:document xmlns:w="${wordNs}"><w:body>${paragraph('项目概况', 1)}${paragraph('费用明细', 2)}${paragraphs.map((text) => paragraph(text)).join('')}<w:tbl><w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr>${paragraph('合计')}</w:tc></w:tr><w:tr><w:tc>${paragraph('名称')}</w:tc><w:tc>${paragraph('金额')}</w:tc></w:tr><w:tr><w:tc>${paragraph('设计费')}</w:tc><w:tc>${paragraph('123.45')}</w:tc></w:tr></w:tbl>${paragraph('文档末尾 END')}</w:body></w:document>`,
    'word/styles.xml': `<w:styles xmlns:w="${wordNs}">${[1, 2].map((level) => `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/><w:pPr><w:outlineLvl w:val="${level - 1}"/></w:pPr></w:style>`).join('')}</w:styles>`,
    'word/_rels/document.xml.rels': `<Relationships xmlns="${relationships}"><Relationship Id="rId1" Type="${relNs}/styles" Target="styles.xml"/></Relationships>`,
  });
}

export function spreadsheetFixture(extraRows = 0) {
  const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  return archive({
    '[Content_Types].xml':
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
    'xl/workbook.xml': `<workbook xmlns="${ns}" xmlns:r="${relNs}"><sheets><sheet name="收入" sheetId="1" r:id="rId1"/><sheet name="支出" sheetId="2" r:id="rId2"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<Relationships xmlns="${relationships}">${[1, 2].map((index) => `<Relationship Id="rId${index}" Type="${relNs}/worksheet" Target="worksheets/sheet${index}.xml"/>`).join('')}</Relationships>`,
    ...Object.fromEntries(
      [1, 2].map((index) => [
        `xl/worksheets/sheet${index}.xml`,
        `<worksheet xmlns="${ns}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>项目 ${index}</t></is></c><c r="B1"><v>${index * 123}</v></c></row>${Array.from({ length: extraRows }, (_, i) => `<row r="${i + 2}"><c r="A${i + 2}" t="inlineStr"><is><t>样例行 ${i + 2}</t></is></c></row>`).join('')}<row r="30"><c r="A30" t="inlineStr"><is><t>最后一行 ${index}</t></is></c></row></sheetData></worksheet>`,
      ]),
    ),
  });
}

export function presentationFixture() {
  const ns = 'http://schemas.openxmlformats.org/presentationml/2006/main';
  return archive({
    '[Content_Types].xml':
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
    'ppt/presentation.xml': `<p:presentation xmlns:p="${ns}" xmlns:r="${relNs}"><p:sldIdLst><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': `<Relationships xmlns="${relationships}">${[1, 2].map((index) => `<Relationship Id="rId${index}" Type="${relNs}/slide" Target="slides/slide${index}.xml"/>`).join('')}</Relationships>`,
    ...Object.fromEntries(
      [1, 2].map((index) => [
        `ppt/slides/slide${index}.xml`,
        `<p:sld xmlns:p="${ns}" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="${index}" name="Text"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>幻灯片 ${index} 完整内容</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
      ]),
    ),
  });
}

/** A real, self-contained two-page PDF with correct xref offsets. */
export function pdfFixture(texts = ['First page content', 'Last page END']) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${texts.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${texts.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ...texts.flatMap((text, index) => {
      const stream = `BT /F1 16 Tf 72 720 Td (${text}) Tj ET`;
      return [
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`,
        `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
      ];
    }),
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const start = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join(
      '',
    )}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  return Buffer.from(pdf);
}

export function wavFixture() {
  const wav = Buffer.alloc(16044);
  wav.write('RIFF');
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24);
  wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(16000, 40);
  return wav;
}
