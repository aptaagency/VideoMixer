const express = require("express");
const multer = require("multer");
const fs = require("fs-extra");
const path = require("path");
const { exec } = require("child_process");
const archiver = require("archiver");
const { v4: uuidv4 } = require("uuid");

const app = express();
const port = process.env.PORT || 3000;

const uploadsDir = "/tmp/uploads";
const resultsDir = "/tmp/results";
const statusMap = {}; // taskId => { status, downloadUrl, etc }

fs.ensureDirSync(uploadsDir);
fs.ensureDirSync(resultsDir);

app.use(express.json({ limit: "2gb" }));
app.use(express.urlencoded({ limit: "2gb", extended: true }));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => cb(null, `${Date.now()}_${file.originalname}`),
});
const upload = multer({ storage });

function runCommand(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, (error, stdout, stderr) => {
      if (error) return reject(stderr || stdout);
      resolve(stdout);
    });
  });
}

async function combineVideos(hookPath, bodyPath, outputPath) {
  const ffmpegCmd = `ffmpeg -hide_banner -loglevel error -stats -fflags +genpts \
-i "${hookPath}" -i "${bodyPath}" \
-filter_complex "[0:v]scale=1920:1080:force_original_aspect_ratio=decrease,\
pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[v0];\
[1:v]scale=1920:1080:force_original_aspect_ratio=decrease,\
pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[v1];\
[0:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,volume=1.0[a0];\
[1:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,volume=1.0[a1];\
[v0][a0][v1][a1]concat=n=2:v=1:a=1[outv][outa]" \
-map "[outv]" -map "[outa]" -c:v libx264 -preset fast -c:a aac -b:a 128k -y "${outputPath}"`;

  return runCommand(ffmpegCmd);
}

async function zipDirectory(source, outPath) {
  const archive = archiver("zip", { zlib: { level: 9 } });
  const stream = fs.createWriteStream(outPath);
  return new Promise((resolve, reject) => {
    archive.directory(source, false).on("error", reject).pipe(stream);
    stream.on("close", resolve);
    archive.finalize();
  });
}

app.post(
  "/upload",
  upload.fields([
    { name: "hooks", maxCount: 10 },
    { name: "bodies", maxCount: 10 },
  ]),
  async (req, res) => {
    const hooks = req.files?.hooks || [];
    const bodies = req.files?.bodies || [];

    if (hooks.length === 0 || bodies.length === 0) {
      return res
        .status(400)
        .json({ error: "Envie pelo menos 1 hook e 1 body" });
    }

    const taskId = uuidv4();
    statusMap[taskId] = { status: "processing" };

    processVideos(taskId, hooks, bodies);

    res.status(202).json({ message: "Upload recebido", taskId });
  }
);

app.get("/status/:taskId", (req, res) => {
  const { taskId } = req.params;
  const taskStatus = statusMap[taskId];

  if (!taskStatus) {
    return res.status(404).json({ error: "taskId não encontrado" });
  }

  res.json(taskStatus);
});

app.use("/results", express.static(resultsDir));

async function processVideos(taskId, hooks, bodies) {
  const taskDir = path.join(resultsDir, taskId);
  await fs.ensureDir(taskDir);

  let successCount = 0;
  const jobs = [];

  for (const hook of hooks) {
    for (const body of bodies) {
      const name = `comb_${path.parse(hook.originalname).name}_${
        path.parse(body.originalname).name
      }.mp4`;
      const outputPath = path.join(taskDir, name);

      const job = combineVideos(hook.path, body.path, outputPath)
        .then(() => successCount++)
        .catch((err) => console.error("Erro ao combinar vídeos:", err));
      jobs.push(job);
    }
  }

  try {
    await Promise.all(jobs);

    const report = `Task: ${taskId}
Data: ${new Date().toLocaleString()}
Combinations: ${hooks.length * bodies.length}
Sucessos: ${successCount}
Falhas: ${hooks.length * bodies.length - successCount}`;

    fs.writeFileSync(path.join(taskDir, "report.txt"), report);

    const zipPath = path.join(resultsDir, `${taskId}.zip`);
    await zipDirectory(taskDir, zipPath);

    statusMap[taskId] = {
      status: "done",
      downloadUrl: `/results/${taskId}.zip`,
      success: successCount,
      total: hooks.length * bodies.length,
    };
  } catch (err) {
    statusMap[taskId] = { status: "error", message: err.message };
  } finally {
    [...hooks, ...bodies].forEach((f) => fs.remove(f.path));
  }
}

const http = require("http");
const server = http.createServer(app);
server.setTimeout(10 * 60 * 1000);

server.listen(port, "0.0.0.0", () => {
  console.log(`✅ Server running on port ${port}`);
});
