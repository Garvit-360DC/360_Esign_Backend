import { Readable } from "node:stream";
import axios from "axios";
import ConvertAPI from "convertapi";
import { env } from "../../config/env";
import { AppError } from "../../utils/appError";

export async function convertDocxToPdf(file: Buffer, fileName: string): Promise<Buffer> {
  try {
    const convertapi = new ConvertAPI(env.CONVERTAPI_SECRET);
    const safeBase =
      fileName.replace(/\.[^.]+$/, "").replace(/[^\w.-]+/g, "_") || "document";
    const uploadResult = await convertapi.upload(Readable.from(file), `${safeBase}.docx`);
    const result = await convertapi.convert("pdf", { File: uploadResult }, "docx");
    const pdfUrl = result?.file?.url;
    if (!pdfUrl) {
      throw new Error("ConvertAPI returned no PDF URL");
    }

    const response = await axios.get<ArrayBuffer>(pdfUrl, {
      responseType: "arraybuffer",
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });

    return Buffer.from(response.data);
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    throw new AppError(
      "Could not convert the Word document to PDF. Check CONVERTAPI_SECRET and try again.",
      502,
      "CONVERSION_FAILED"
    );
  }
}
