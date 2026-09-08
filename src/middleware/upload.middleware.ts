import multer from "multer";
import { AppError } from "../utils/appError";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export const uploadDocument = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok =
      file.mimetype === DOCX_MIME || file.originalname.toLowerCase().endsWith(".docx");
    if (!ok) {
      cb(new AppError("The document must be a Word .docx file.", 400, "INVALID_FILE"));
      return;
    }
    cb(null, true);
  },
}).single("document");
