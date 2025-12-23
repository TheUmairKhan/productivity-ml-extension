export type PageLabel = "productive" | "waste" | "skip";

export interface PageCapture {
    raw_url: string;
    url: string;
    html?: string;
    screenshot?: string;
    label: PageLabel
}