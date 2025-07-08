const express = require("express");
const multer = require("multer");
const fs = require("fs-extra");
const path = require("path");
const { exec } = require("child_process");
const archiver = require("archiver");

const app = express();
const port = process.env.PORT || 3000;

const tempBase = "/tmp";
const hooksFolder = path.join(tempBase, "hooks");
const bodiesFolder = path.join(tempBase, "corpos");
const outputFolder = path.join(tempBase, "results");
const tempUpload = path.join(tempBase, "uploads");

[hooksFolder, bodiesFolder, outputFolder, tempUpload].forEach((folder) => {
  fs.ensureDirSync(folder);
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, tempUpload);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}_${file.originalname}`);
  },
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
  "/combine",
  upload.fields([
    { name: "hooks", maxCount: 10 },
    { name: "bodies", maxCount: 10 },
  ]),
  async (req, res) => {
    try {
      const hooks = req.files?.hooks || [];
      const bodies = req.files?.bodies || [];

      if (hooks.length === 0 || bodies.length === 0) {
        return res
          .status(400)
          .json({ error: "Please upload both hook and body videos" });
      }

      const timestamp = new Date()
        .toISOString()
        .replace(/[-:T]/g, "")
        .split(".")[0];

      const thisRunFolder = path.join(outputFolder, timestamp);
      await fs.ensureDir(thisRunFolder);

      const jobs = [];
      let successCount = 0;

      for (const hook of hooks) {
        for (const body of bodies) {
          const outputName = `comb_${path.parse(hook.originalname).name}_${
            path.parse(body.originalname).name
          }.mp4`;
          const outputFile = path.join(thisRunFolder, outputName);

          const job = combineVideos(hook.path, body.path, outputFile)
            .then(() => successCount++)
            .catch((err) =>
              console.error(`❌ Error combining ${outputName}:`, err)
            );
          jobs.push(job);
        }
      }

      await Promise.all(jobs);

      const report = `=== REPORT (${new Date().toLocaleString()}) ===
Hooks: ${hooks.length}
Bodies: ${bodies.length}
Combinations: ${hooks.length * bodies.length}
Successes: ${successCount}
Failures: ${hooks.length * bodies.length - successCount}
Output folder: ${thisRunFolder}
`;

      fs.writeFileSync(path.join(thisRunFolder, "report.txt"), report);

      const zipPath = path.join(outputFolder, `videos_${timestamp}.zip`);
      await zipDirectory(thisRunFolder, zipPath);

      [...hooks, ...bodies].forEach((f) => fs.remove(f.path));

      res.status(200).json({
        message: "Videos processed!",
        zipPath,
      });
    } catch (err) {
      console.error("🔥 Error:", err);
      res.status(500).json({ error: "Internal error", details: err.message });
    }
  }
);

const http = require("http");
const server = http.createServer(app);
server.setTimeout(10 * 60 * 1000);

server.listen(port, "0.0.0.0", () => {
  console.log(`✅ Server running on port ${port}`);
});
