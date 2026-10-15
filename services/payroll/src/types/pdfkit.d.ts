declare module 'pdfkit' {
  class PDFDocument {
    constructor(options?: Record<string, unknown>)
    y: number
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    on(event: string, callback: (...args: any[]) => void): this
    fontSize(size: number): this
    text(text: string, options?: Record<string, unknown>): this
    text(text: string, x?: number, y?: number, options?: Record<string, unknown>): this
    moveDown(lines?: number): this
    registerFont(name: string, src: string): this
    font(name: string): this
    fillColor(color: string): this
    rect(x: number, y: number, w: number, h: number): this
    fill(color?: string): this
    moveTo(x: number, y: number): this
    lineTo(x: number, y: number): this
    stroke(color?: string): this
    addPage(options?: Record<string, unknown>): this
    end(): void
  }
  export default PDFDocument
}
