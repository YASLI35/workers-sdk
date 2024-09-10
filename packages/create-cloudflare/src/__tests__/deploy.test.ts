import { mockPackageManager, mockSpinner } from "helpers/__tests__/mocks";
import { processArgument } from "helpers/args";
import { runCommand } from "helpers/command";
import { readFile } from "helpers/files";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { offerToDeploy, runDeploy } from "../deploy";
import { chooseAccount, wranglerLogin } from "../wrangler/accounts";
import { createTestContext } from "./helpers";

vi.mock("helpers/command");
vi.mock("../wrangler/accounts");
vi.mock("helpers/args");
vi.mock("@cloudflare/cli/interactive");
vi.mock("which-pm-runs");
vi.mock("helpers/files");

const mockInsideGitRepo = (isInside = true) => {
	if (isInside) {
		vi.mocked(runCommand).mockResolvedValueOnce(
			"On branch master\nnothing to commit, working tree clean",
		);
	} else {
		vi.mocked(runCommand).mockRejectedValueOnce(
			new Error(
				"fatal: not a git repository (or any of the parent directories): .git",
			),
		);
	}
};

describe("deploy helpers", async () => {
	beforeEach(() => {
		mockPackageManager("npm");

		mockSpinner();
	});

	describe("offerToDeploy", async () => {
		test("user selects yes and succeeds", async () => {
			const ctx = createTestContext();
			ctx.template.platform = "pages";
			// mock the user selecting yes when asked to deploy
			vi.mocked(processArgument).mockResolvedValueOnce(true);
			// mock a successful wrangler login
			vi.mocked(wranglerLogin).mockResolvedValueOnce(true);

			await expect(offerToDeploy(ctx)).resolves.toBe(true);
		});

		test("project is undeployable (simple binding)", async () => {
			const ctx = createTestContext();
			// Can't deploy things with bindings (yet!)
			vi.mocked(readFile).mockReturnValue(`binding = "MY_QUEUE"`);

			await expect(offerToDeploy(ctx)).resolves.toBe(false);
			expect(processArgument).toHaveBeenCalledOnce();
			expect(ctx.args.deploy).toBe(false);
			expect(wranglerLogin).not.toHaveBeenCalled();
		});

		test("project is undeployable (complex binding)", async () => {
			const ctx = createTestContext();
			// Can't deploy things with bindings (yet!)
			vi.mocked(readFile).mockReturnValue(`
				experimental_assets = { directory = "./dist", binding = "ASSETS" }

				[[durable_objects.bindings]]
				name = "MY_DURABLE_OBJECT"
				class_name = "MyDurableObject"
			`);

			await expect(offerToDeploy(ctx)).resolves.toBe(false);
			expect(processArgument).toHaveBeenCalledOnce();
			expect(ctx.args.deploy).toBe(false);
			expect(wranglerLogin).not.toHaveBeenCalled();
		});

		test("assets project is deployable (no other bindings)", async () => {
			const ctx = createTestContext();
			vi.mocked(readFile).mockReturnValue(`
				experimental_assets = { directory = "./dist", binding = "ASSETS" }
			`);
			// mock the user selecting yes when asked to deploy
			vi.mocked(processArgument).mockResolvedValueOnce(true);
			// mock a successful wrangler login
			vi.mocked(wranglerLogin).mockResolvedValueOnce(true);

			await expect(offerToDeploy(ctx)).resolves.toBe(true);
			expect(processArgument).toHaveBeenCalledOnce();
			expect(ctx.args.deploy).toBe(true);
			expect(wranglerLogin).toHaveBeenCalled();
		});

		test("--no-deploy from command line", async () => {
			const ctx = createTestContext();
			ctx.args.deploy = false;
			ctx.template.platform = "pages";

			await expect(offerToDeploy(ctx)).resolves.toBe(false);
			expect(processArgument).toHaveBeenCalledOnce();
			expect(ctx.args.deploy).toBe(false);
			expect(wranglerLogin).not.toHaveBeenCalled();
		});

		test("wrangler login failure", async () => {
			const ctx = createTestContext();
			ctx.template.platform = "pages";
			vi.mocked(processArgument).mockResolvedValueOnce(true);
			vi.mocked(wranglerLogin).mockResolvedValueOnce(false);

			await expect(offerToDeploy(ctx)).resolves.toBe(false);
			expect(chooseAccount).not.toHaveBeenCalled();
		});
	});

	describe("runDeploy", async () => {
		const commitMsg = "initial commit";
		const deployedUrl = "https://test-project-1234.pages.dev";

		test("happy path", async () => {
			const ctx = createTestContext();
			ctx.account = { id: "test1234", name: "Test Account" };
			ctx.template.platform = "pages";
			ctx.commitMessage = commitMsg;
			mockInsideGitRepo(false);
			vi.mocked(runCommand).mockResolvedValueOnce(deployedUrl);

			await runDeploy(ctx);
			expect(runCommand).toHaveBeenCalledWith(
				["npm", "run", "deploy", "--", "--commit-message", `"${commitMsg}"`],
				expect.any(Object),
			);
			expect(ctx.deployment.url).toBe(deployedUrl);
		});

		test("no account in ctx", async () => {
			const ctx = createTestContext();
			ctx.account = undefined;
			await expect(() => runDeploy(ctx)).rejects.toThrow(
				"Failed to read Cloudflare account.",
			);
		});

		test("Failed deployment", async () => {
			const ctx = createTestContext();
			ctx.account = { id: "test1234", name: "Test Account" };
			ctx.template.platform = "pages";
			ctx.commitMessage = commitMsg;
			mockInsideGitRepo(false);
			vi.mocked(runCommand).mockResolvedValueOnce("");

			await expect(() => runDeploy(ctx)).rejects.toThrow(
				"Failed to find deployment url.",
			);
		});
	});
});
