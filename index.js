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
    const child = exec(
      cmd,
      { timeout: 5 * 60 * 1000 },
      (error, stdout, stderr) => {
        if (error) {
          console.error("⚠️ FFmpeg error:", stderr || stdout || error.message);
          return reject(stderr || stdout || error.message);
        }
        resolve(stdout);
      }
    );

    child.on("error", (err) => {
      console.error("❌ Exec error:", err);
      reject(err);
    });
  });
}

async function combineVideos(hookPath, bodyPath, outputPath) {
  const ffmpegCmd = `ffmpeg -nostdin -hide_banner -loglevel error -stats -fflags +genpts \
-i "${hookPath}" -i "${bodyPath}" \
-filter_complex "[0:v]scale=1920:1080:force_original_aspect_ratio=decrease,\
pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[v0];\
[1:v]scale=1920:1080:force_original_aspect_ratio=decrease,\
pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[v1];\
[0:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,volume=1.0[a0];\
[1:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,volume=1.0[a1];\
[v0][a0][v1][a1]concat=n=2:v=1:a=1[outv][outa]" \
-map "[outv]" -map "[outa]" -c:v libx264 -preset fast -c:a aac -b:a 128k -y "${outputPath}"`;

  console.log("🎬 Executing FFmpeg command:");
  console.log(ffmpegCmd);

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

function saveStatus(taskId, data) {
  const statusPath = path.join(resultsDir, taskId, "status.json");
  fs.ensureDirSync(path.dirname(statusPath));
  fs.writeJsonSync(statusPath, data);
  console.log(`✅ Status saved at ${statusPath}:`, data);
}

function getStatus(taskId) {
  const statusPath = path.join(resultsDir, taskId, "status.json");
  if (!fs.existsSync(statusPath)) return null;

  try {
    return fs.readJsonSync(statusPath);
  } catch (err) {
    console.log("❌ Failed to read status.json:", err.message);
    return null;
  }
}

app.post(
  "/upload",
  upload.fields([
    { name: "hooks", maxCount: 10 },
    { name: "bodies", maxCount: 10 },
  ]),
  (req, res) => {
    const hooks = req.files?.hooks || [];
    const bodies = req.files?.bodies || [];

    if (hooks.length === 0 || bodies.length === 0) {
      return res
        .status(400)
        .json({ error: "Send at least 1 hook and 1 body video." });
    }

    const taskId = uuidv4();
    console.log("🆕 New task:", taskId);
    saveStatus(taskId, { status: "processing" });

    // Chama o processamento e captura qualquer erro inesperado
    processVideos(taskId, hooks, bodies).catch((err) => {
      console.error(`[${taskId}] Unhandled error:`, err);
      saveStatus(taskId, { status: "error", message: err.message });
    });

    res.status(202).json({ message: "Upload received", taskId });
  }
);

app.get("/status/:taskId", (req, res) => {
  const taskStatus = getStatus(req.params.taskId);
  if (!taskStatus) return res.status(404).json({ error: "Task not found" });
  res.json(taskStatus);
});

app.use("/results", express.static(resultsDir));

async function processVideos(taskId, hooks, bodies) {
  console.log(`[${taskId}] Starting video processing...`);
  const taskDir = path.join(resultsDir, taskId);
  await fs.ensureDir(taskDir);

  let successCount = 0;

  try {
    for (const hook of hooks) {
      for (const body of bodies) {
        const name = `comb_${path.parse(hook.originalname).name}_${
          path.parse(body.originalname).name
        }.mp4`;
        const outputPath = path.join(taskDir, name);

        console.log(`[${taskId}] Processing combination: ${name}`);
        try {
          await combineVideos(hook.path, body.path, outputPath);
          console.log(`[${taskId}] ✅ Finished: ${name}`);
          successCount++;
        } catch (err) {
          console.error(`[${taskId}] ❌ Error combining ${name}:`, err);
        }
      }
    }

    const report = `Task: ${taskId}
Date: ${new Date().toLocaleString()}
Combinations: ${hooks.length * bodies.length}
Successes: ${successCount}
Failures: ${hooks.length * bodies.length - successCount}`;
    fs.writeFileSync(path.join(taskDir, "report.txt"), report);
    console.log(`[${taskId}] 📝 Report created.`);

    const zipPath = path.join(resultsDir, `${taskId}.zip`);
    await zipDirectory(taskDir, zipPath);
    console.log(`[${taskId}] 📦 Zip file created.`);

    saveStatus(taskId, {
      status: "done",
      downloadUrl: `/results/${taskId}.zip`,
      success: successCount,
      total: hooks.length * bodies.length,
    });
    console.log(`[${taskId}] ✅ Status updated to done.`);
  } catch (err) {
    console.error(`[${taskId}] ❌ Fatal error:`, err);
    saveStatus(taskId, { status: "error", message: err.message });
  } finally {
    console.log(`[${taskId}] 🧹 Cleaning up temp files.`);
    [...hooks, ...bodies].forEach((f) => fs.remove(f.path));
  }
}

const http = require("http");
const server = http.createServer(app);
server.setTimeout(10 * 60 * 1000); // 10 minutos
server.listen(port, "0.0.0.0", () => {
  console.log(`🚀 Server running on http://0.0.0.0:${port}`);
});
