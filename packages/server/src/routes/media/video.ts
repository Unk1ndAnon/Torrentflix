import { JobId } from "bull";
import { randomUUID } from "crypto";
import express, { NextFunction, Request, Response } from "express";
import { createReadStream, existsSync, statSync } from "fs";
import { join } from "path/posix";
import { config } from "../../config";
import { torrentQueue } from "../../queues/torrentQueue";
import { killJob } from "../../utils/killJob";
import prismaClient from "../../database/prisma";

const router = express.Router();

const queueMiddleware = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const magnetLink = req.body.magnetLink as string;
  const re = /dn=(?<link>.+?)\&/;
  const match = magnetLink.match(re);
  const fileName = decodeURI(match?.groups?.link as string);
  const hashedValue = randomUUID();
  const job = await torrentQueue.add(
    { magnetLink, fileName, hashedValue },
    { removeOnFail: true, removeOnComplete: true, attempts: 0, lifo: true }
  );

  res.locals.magnetLink = magnetLink;
  res.locals.fileName = fileName;
  res.locals.jobId = job.id;
  res.locals.hash = hashedValue;
  next();
};

router.get("/", async function (_: Request, res: Response) {
  const videos = await prismaClient.video.findMany({});
  if (videos.length === 0) return res.json({ message: "No videos found" });
  return res.json(videos);
});

router.get("/progress", async function (_: Request, res: Response) {
  const jobs = await torrentQueue.getJobs(["active"]);
  res.json(jobs);
});

router.delete("/:id", async function (req: Request, res: Response) {
  const id = Number(req.params.id);
  const video = await prismaClient.video.findFirst({ where: { id } });
  const jobId = video?.jobId as JobId;
  const job = await torrentQueue.getJob(jobId);
  if (job?.isActive) {
    await killJob(torrentQueue, job.id).catch((err) => console.log(err));
  }
  await prismaClient.video.delete({ where: { id } });
  res.json("Successfully deleted");
});

router.post("/", queueMiddleware, async function (req: Request, res: Response) {
  try {
    const { fileName, magnetLink, hash, jobId } = res.locals;
    const filePath = join(config.rootVideoPath, "encodedVideos", fileName);
    const video = await prismaClient.video.create({
      data: {
        filename: fileName,
        hash,
        jobId,
        path: filePath,
        magnetLink: magnetLink,
        userId: 1,
      },
    });

    return res.json({ video });
  } catch (err) {
    return res.json("Error occured");
  }
});

router.get("/:id", async (req: Request, res: Response) => {
  const id = Number(req.params.id);

  const video = await prismaClient.video.findFirst({
    where: { id },
    select: { path: true, filename: true },
  });
  if (!video) return res.status(404).json("Video not found");
  const vidPath = join(video.path, video.filename);
  if (!existsSync(vidPath)) return res.status(404).json("Video doesnt exist");

  const stat = statSync(vidPath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunksize = end - start + 1;
    const file = createReadStream(vidPath, { start, end });
    const head = {
      "Content-Range": `bytes ${start}-${end}/${fileSize}`,
      "Accept-Ranges": "bytes",
      "Content-Length": chunksize,
      "Content-Type": "video/mp4",
    };
    res.writeHead(206, head);
    file.pipe(res);
  } else {
    const head = {
      "Content-Type": "video/mp4",
      "Content-Length": fileSize,
    };
    res.writeHead(200, head);
    createReadStream(vidPath).pipe(res);
  }
});

export default router;