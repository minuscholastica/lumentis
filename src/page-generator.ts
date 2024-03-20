import fs from "fs";
import path from "path";
import { LUMENTIS_FOLDER, RUNNERS } from "./constants";
import { exec, execSync, spawn } from "child_process";
import { ReadyToGeneratePage, WizardState } from "./types";
import { runClaudeInference } from "./ai";

function writeConfigFiles(directory: string, wizardState: WizardState) {
  let packageJSON = fs.existsSync(path.join(directory, "package.json"))
    ? JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf-8"))
    : {};

  packageJSON = {
    ...packageJSON,
    name: wizardState.title + " - made with Lumentis",
    description: wizardState.description,
    version: "0.0.1",
    scripts: {
      // dev: "URL=http://localhost:3000 && (open $URL || cmd.exe /c start $URL) && next dev",
      dev: "next dev -p 5656 & node start.js",
      build: "next build",
      start: "next start",
    },
    keywords: wizardState.coreThemes?.split(",").map((kw) => kw.trim()) || [],
  };

  fs.writeFileSync(
    path.join(directory, "package.json"),
    JSON.stringify(packageJSON, null, 2)
  );

  fs.writeFileSync(
    path.join(directory, "next.config.js"),
    `module.exports = require("nextra")({
      theme: "nextra-theme-docs",
      themeConfig: "./theme.config.jsx",
      titleSuffix: "${wizardState.title}",
    })();`
  );

  fs.writeFileSync(
    path.join(directory, "theme.config.jsx"),
    `export default {
      logo: <span>${wizardState.title} - made with Lumentis</span>,
      editLink: {
        component: null,
      },
      project: {
        link: "https://github.com/hrishioa/lumentis",
      },
      feedback: {
        content: null,
      },
      head: (
        <>
          <meta property="og:title" content="${wizardState.title}" />
          <meta property="og:description" content="${wizardState.description}" />
          <meta name="robots" content="noindex, nofollow" />
        </>
      ),
    };
    `
  );

  fs.writeFileSync(
    path.join(directory, ".gitignore"),
    `.DS_Store
.next/
node_modules/
*.log
dist/
.turbo/
out/
# Theme styles
packages/nextra-theme-*/style.css

# Stork related
*/**/public/*.st
*/**/public/*.toml

.vercel
.idea/
.eslintcache
.env

tsup.config.bundled*
tsconfig.tsbuildinfo

${LUMENTIS_FOLDER}`
  );

  //prettier-ignore
  fs.writeFileSync(
    path.join(directory, "start.js"),
`const { exec } = require("child_process");
const url = "http://localhost:5656";

setTimeout(() => {
  const platform = process.platform;
  let command;

  if (platform === "darwin") {
    command = "open";
  } else if (platform === "win32") {
    command = "start";
  } else {
    command = "xdg-open";
  }

  console.log("Executing...");
  const child = exec(command + " " + url, {detached: true});
  child.unref();
}, 8000);
`);

  // prettier-ignore
  fs.writeFileSync(
    path.join(directory, "README.md"),
`## ${wizardState.title} - made with Lumentis

\`curl -fsSL https://bun.sh/install | bash # Install bun for macOS, Linux, and WSL\`

\`bun install\`

\`bun dev\`

Change things in \`pages\` to see the effect.
`
  )

  if (!fs.existsSync(path.join(directory, "pages"))) {
    fs.mkdirSync(path.join(directory, "pages"));
  }
}

export function idempotentlySetupNextraDocs(
  directory: string,
  runner: (typeof RUNNERS)[number],
  wizardState: WizardState
) {
  // TODO: This might not be working?
  if (fs.existsSync(path.join(directory, "package.json"))) {
    console.log("Looks like project directory should be set up, skipping...");
    return;
  }

  try {
    execSync(
      `${runner.command} ${runner.installPrefix} react react-dom nextra nextra-theme-docs`,
      {
        cwd: directory,
        stdio: "inherit",
      }
    );
  } catch (err) {
    throw new Error(`Failed to install Requirements: ${err}`);
  }

  writeConfigFiles(directory, wizardState);
}

export async function generatePages(
  startNextra: boolean,
  pages: ReadyToGeneratePage[],
  pagesFolder: string,
  wizardState: WizardState
) {
  if (!fs.existsSync(pagesFolder)) {
    throw new Error(`Pages folder ${pagesFolder} does not exist`);
  }

  const preferredRunner = RUNNERS.find(
    (runner) => runner.command === wizardState.preferredRunnerForNextra
  )!;

  if (startNextra) {
    const devProcess = exec(`${preferredRunner.command} run dev`, {
      cwd: path.join(pagesFolder, ".."),
      // stdio: "ignore",
      // detached: true,
    });

    process.on("exit", () => {
      devProcess.kill();
    });

    process.on("SIGINT", () => {
      devProcess.kill();
      process.exit();
    });
  }

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const permalink = i === 0 ? "index" : page.section.permalink;

    const pageFolder = path.join(pagesFolder, ...page.levels.slice(0, -1));

    if (page.levels.length && !fs.existsSync(pageFolder)) {
      fs.mkdirSync(pageFolder, { recursive: true });
    }

    if (!fs.existsSync(path.join(pageFolder, "_meta.json"))) {
      fs.writeFileSync(path.join(pageFolder, "_meta.json"), JSON.stringify({}));
    }

    const metaJSON = JSON.parse(
      fs.readFileSync(path.join(pageFolder, "_meta.json"), "utf-8")
    );

    if (!metaJSON[permalink]) {
      metaJSON[permalink] = page.section.title;
      if (i === 1) {
        if (
          pages.find(
            (p) =>
              p.levels.length > 1 && p.levels[0] === pages[0].section.permalink
          )
        )
          metaJSON[pages[0].section.permalink] = "Basics";
      }

      fs.writeFileSync(
        path.join(pageFolder, "_meta.json"),
        JSON.stringify(metaJSON, null, 2)
      );
    }

    const pagePath = path.join(pageFolder, permalink + ".mdx");

    if (!wizardState.overwritePages && fs.existsSync(pagePath)) {
      console.log("Page already exists, skipping...");
      continue;
    }

    if (!wizardState.pageGenerationModel)
      throw new Error("No page generation model set");

    await runClaudeInference(
      page.messages,
      wizardState.pageGenerationModel,
      4096,
      wizardState.anthropicKey,
      wizardState.streamToConsole,
      `${page.levels.join("->")}.mdx`,
      undefined,
      pagePath,
      `import { Callout, Steps, Step } from "nextra-theme-docs";\n\n`
    );
  }

  console.log(
    `\n\nAND WE'RE DONE! Run \`${preferredRunner.command} run dev\` to start the docs server once you quit. You can always rerun Lumentis to make changes.`
  );
}
