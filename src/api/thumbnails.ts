import { randomBytes } from "crypto";
import { join } from "path";
import { getBearerToken, validateJWT } from "../auth";
import { respondWithJSON } from "./json";
import { getVideo, updateVideo } from "../db/videos";
import type { ApiConfig } from "../config";
import type { BunRequest } from "bun";
import {
  BadRequestError,
  NotFoundError,
  UserForbiddenError,
} from "./errors";

const MAX_UPLOAD_SIZE = 10 << 20;

export async function handlerUploadThumbnail(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  console.log("uploading thumbnail for video", videoId, "by user", userID);

  const formData = await req.formData();
  const file = formData.get("thumbnail");
  if (!(file instanceof File)) {
    throw new BadRequestError("Missing thumbnail image");
  }
  if (file.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("Thumbnail image is too large");
  }

  const mediaType = file.type;
  if (mediaType !== "image/jpeg" && mediaType !== "image/png") {
    throw new BadRequestError("Thumbnail must be a JPEG or PNG image");
  }

  const data = await file.arrayBuffer();
  const fileExtension = mediaType.split("/")[1];
  if (!fileExtension) {
    throw new BadRequestError("Invalid thumbnail media type");
  }

  const video = getVideo(cfg.db, videoId);
  if (!video) {
    throw new NotFoundError("Couldn't find video");
  }
  if (video.userID !== userID) {
    throw new UserForbiddenError("Not authorized to update this video");
  }

  const randomFileName = randomBytes(32).toString("base64url");
  const fileName = `${randomFileName}.${fileExtension}`;
  const filePath = join(cfg.assetsRoot, fileName);
  await Bun.write(filePath, data);

  const updatedVideo = {
    ...video,
    thumbnailURL: `http://localhost:${cfg.port}/assets/${fileName}`,
  };
  updateVideo(cfg.db, updatedVideo);

  return respondWithJSON(200, updatedVideo);
}
