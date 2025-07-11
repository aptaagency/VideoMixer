const express = require("express");
const multer = require("multer");
const cors = require("cors");
const fs = require("fs-extra");
const path = require("path");
const { exec } = require("child_process");
const archiver = require("archiver");
const { v4: uuidv4 } = require("uuid");
const pLimit = require("p-limit");

const app = express();

app.use(
  cors({
    origin: "https://v8n26s.csb.app",
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"],
  })
);

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
      { timeout: 10 * 60 * 1000 },
      (error, stdout, stderr) => {
        console.log("🔧 STDOUT:\n", stdout);
        console.error("🔧 STDERR:\n", stderr);
        if (error) {
          console.error("❌ Exec error:", error.message);
          return reject(stderr || stdout || error.message);
        }
        resolve(stdout);
      }
    );

    child.on("error", (err) => {
      console.error("❌ Child process error:", err);
      reject(err);
    });
  });
}

async function combineVideos(hookPath, bodyPath, outputPath) {
  const tempDir = path.join("/tmp", "intermediate", uuidv4());
  await fs.ensureDir(tempDir);

  const hookTs = path.join(tempDir, "hook.ts");
  const bodyTs = path.join(tempDir, "body.ts");
  const inputsFile = path.join(tempDir, "inputs.txt");

  const normalizeForFFmpeg = (p) => p.replace(/\\/g, "/");

  const transcode = async (inputPath, outputTs) => {
    const cmd = `ffmpeg -nostdin -hide_banner -loglevel error -stats -i "${inputPath}" \
-vf "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black" \
-c:v libx264 -preset veryslow -crf 23 -c:a aac -b:a 128k -f mpegts -y "${outputTs}"`;
    return runCommand(cmd);
  };

  await transcode(hookPath, hookTs);
  await transcode(bodyPath, bodyTs);

  await fs.writeFile(
    inputsFile,
    `file '${normalizeForFFmpeg(hookTs)}'\nfile '${normalizeForFFmpeg(
      bodyTs
    )}'\n`
  );

  const concatCmd = `ffmpeg -nostdin -hide_banner -loglevel error -stats -f concat -safe 0 -i "${inputsFile}" -c copy -movflags +faststart -y "${outputPath}"`;
  await runCommand(concatCmd);

  await fs.remove(tempDir); // limpa os arquivos temporários
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
  console.log(`[${taskId}] 💾 Status saved:`, data);
}

function getStatus(taskId) {
  const statusPath = path.join(resultsDir, taskId, "status.json");
  if (!fs.existsSync(statusPath)) return null;

  try {
    return fs.readJsonSync(statusPath);
  } catch (err) {
    console.log(`[${taskId}] ❌ Failed to read status.json:`, err.message);
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

    processVideos(taskId, hooks, bodies).catch((err) => {
      console.error(`[${taskId}] ❌ Unhandled processing error:`, err);
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
  const taskDir = path.join(resultsDir, taskId);
  await fs.ensureDir(taskDir);

  let successCount = 0;
  const limit = pLimit(2); // máximo 2 vídeos processando ao mesmo tempo
  const tasks = [];

  for (const hook of hooks) {
    for (const body of bodies) {
      const name = `comb_${uuidv4()}.mp4`;
      const outputPath = path.join(taskDir, name);

      tasks.push(
        limit(async () => {
          try {
            console.log(`[${taskId}] 🎬 Executando FFmpeg para ${name}`);
            await combineVideos(hook.path, body.path, outputPath);
            successCount++;
          } catch (err) {
            console.error(`[${taskId}] ❌ Erro combinando ${name}:`, err);
          }
        })
      );
    }
  }

  await Promise.all(tasks);

  try {
    const report = `Task: ${taskId}
Data: ${new Date().toLocaleString()}
Combinations: ${hooks.length * bodies.length}
Sucessos: ${successCount}
Falhas: ${hooks.length * bodies.length - successCount}`;

    fs.writeFileSync(path.join(taskDir, "report.txt"), report);

    const zipPath = path.join(resultsDir, `${taskId}.zip`);
    await zipDirectory(taskDir, zipPath);

    saveStatus(taskId, {
      status: "done",
      downloadUrl: `/results/${taskId}.zip`,
      success: successCount,
      total: hooks.length * bodies.length,
    });
  } catch (err) {
    saveStatus(taskId, { status: "error", message: err.message });
  }
}

const http = require("http");
const server = http.createServer(app);
server.setTimeout(10 * 60 * 1000); // 10 minutos
server.listen(port, "0.0.0.0", () => {
  console.log(`🚀 Server running on http://0.0.0.0:${port}`);
});
