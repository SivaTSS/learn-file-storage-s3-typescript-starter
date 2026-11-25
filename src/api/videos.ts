import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { join } from "path";
import { unlink } from "fs/promises";
import { respondWithJSON } from "./json";
import { type ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { getBearerToken, validateJWT } from "../auth";
import { getVideo, updateVideo } from "../db/videos";
import {
  BadRequestError,
  NotFoundError,
  UserForbiddenError,
} from "./errors";

const MAX_UPLOAD_SIZE = 1 << 30;

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);
  const video = getVideo(cfg.db, videoId);
  if (!video) {
    throw new NotFoundError("Couldn't find video");
  }
  if (video.userID !== userID) {
    throw new UserForbiddenError("Not authorized to update this video");
  }

  const formData = await req.formData();
  const file = formData.get("video");
  if (!(file instanceof File)) {
    throw new BadRequestError("Missing video file");
  }
  if (file.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("Video file is too large");
  }
  if (file.type !== "video/mp4") {
    throw new BadRequestError("Video must be an MP4 file");
  }

  const tempPath = join(tmpdir(), `tubely-${randomUUID()}.mp4`);
  let processedPath: string | undefined;

  try {
    await Bun.write(tempPath, file);
    const aspectRatio = await getVideoAspectRatio(tempPath);
    processedPath = await processVideoForFastStart(tempPath);
    const key = `${aspectRatio}/${videoId}.mp4`;

    await cfg.s3Client.file(key).write(Bun.file(processedPath), {
      type: file.type,
    });

    const updatedVideo = {
      ...video,
      videoURL: `${cfg.s3CfDistribution}/${key}`,
    };
    updateVideo(cfg.db, updatedVideo);

    return respondWithJSON(200, updatedVideo);
  } finally {
    await unlink(tempPath).catch(() => {});
    if (processedPath) {
      await unlink(processedPath).catch(() => {});
    }
  }
}

export async function getVideoAspectRatio(filePath: string): Promise<string> {
  const proc = Bun.spawn({
    cmd: [
      "ffprobe",
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "json",
      filePath,
    ],
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdoutText, stderrText] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(stderrText || `ffprobe exited with status ${exitCode}`);
  }

  const result = JSON.parse(stdoutText) as {
    streams?: Array<{ width?: number; height?: number }>;
  };
  const { width, height } = result.streams?.[0] ?? {};
  if (!width || !height) {
    throw new Error("ffprobe did not return video dimensions");
  }

  const ratio = width / height;
  if (Math.abs(ratio - 16 / 9) < 0.02) {
    return "landscape";
  }
  if (Math.abs(ratio - 9 / 16) < 0.02) {
    return "portrait";
  }
  return "other";
}

export async function processVideoForFastStart(
  inputFilePath: string,
): Promise<string> {
  const outputFilePath = `${inputFilePath}.processed`;
  const proc = Bun.spawn({
    cmd: [
      "ffmpeg",
      "-i",
      inputFilePath,
      "-movflags",
      "faststart",
      "-map_metadata",
      "0",
      "-codec",
      "copy",
      "-f",
      "mp4",
      outputFilePath,
    ],
    stdout: "ignore",
    stderr: "pipe",
  });

  const stderrText = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(stderrText || `ffmpeg exited with status ${exitCode}`);
  }

  return outputFilePath;
}
