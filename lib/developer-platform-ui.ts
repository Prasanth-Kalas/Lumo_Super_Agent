export type DeveloperSubmissionStatus =
  | "pending"
  | "certification_failed"
  | "approved"
  | "rejected"
  | "revoked";

export type DeveloperCertificationStatus = "passed" | "needs_review" | "failed";

export interface DeveloperSubmissionLike {
  status: DeveloperSubmissionStatus;
  certification_status?: DeveloperCertificationStatus | null;
}

export interface DeveloperCertificationLike {
  status: DeveloperCertificationStatus;
}

export interface DeveloperPlatformStats {
  total: number;
  approved: number;
  inReview: number;
  blocked: number;
}

export type DeveloperLaunchStepStatus = "done" | "active" | "blocked" | "idle";

export interface DeveloperLaunchStep {
  id: "starter" | "certify" | "submit" | "publish";
  title: string;
  detail: string;
  status: DeveloperLaunchStepStatus;
}

export function developerPlatformStats(
  submissions: DeveloperSubmissionLike[] | null | undefined,
): DeveloperPlatformStats {
  const rows = Array.isArray(submissions) ? submissions : [];
  return {
    total: rows.length,
    approved: rows.filter((row) => row.status === "approved").length,
    inReview: rows.filter((row) => row.status === "pending").length,
    blocked: rows.filter((row) =>
      row.status === "certification_failed" ||
      row.status === "rejected" ||
      row.status === "revoked",
    ).length,
  };
}

export function developerPlatformSummary(
  submissions: DeveloperSubmissionLike[] | null | undefined,
): string {
  const stats = developerPlatformStats(submissions);
  if (stats.total === 0) {
    return "Start with the template, run checks, then submit a manifest.";
  }
  if (stats.approved > 0) {
    return `${stats.approved} live agent${stats.approved === 1 ? "" : "s"} · ${stats.inReview} in review · ${stats.blocked} blocked`;
  }
  if (stats.inReview > 0) {
    return `${stats.inReview} submission${stats.inReview === 1 ? "" : "s"} in review.`;
  }
  return `${stats.blocked} submission${stats.blocked === 1 ? "" : "s"} need attention.`;
}

export function buildDeveloperLaunchSteps(input: {
  submissions?: DeveloperSubmissionLike[] | null;
  manifestUrl?: string | null;
  preflight?: DeveloperCertificationLike | null;
}): DeveloperLaunchStep[] {
  const submissions = Array.isArray(input.submissions) ? input.submissions : [];
  const hasManifest = !!input.manifestUrl?.trim();
  const hasSubmission = submissions.length > 0;
  const hasApproved = submissions.some((row) => row.status === "approved");
  const hasPending = submissions.some((row) => row.status === "pending");
  const hasBlocked = submissions.some((row) =>
    row.status === "certification_failed" ||
    row.status === "rejected" ||
    row.status === "revoked",
  );
  const preflight = input.preflight?.status ?? null;

  return [
    {
      id: "starter",
      title: "Build from the starter",
      detail: "Manifest, tools, scopes, and health probe in one repo.",
      status: hasManifest || hasSubmission ? "done" : "active",
    },
    {
      id: "certify",
      title: "Run local certification",
      detail: "Catch schema, scope, health, and cost issues before review.",
      status:
        preflight === "passed"
          ? "done"
          : preflight === "failed" || preflight === "needs_review"
            ? "blocked"
            : hasManifest
              ? "active"
              : "idle",
    },
    {
      id: "submit",
      title: "Submit for review",
      detail: "Lumo records the manifest and opens the certification queue.",
      status: hasSubmission
        ? "done"
        : preflight === "passed"
          ? "active"
          : "idle",
    },
    {
      id: "publish",
      title: "Go live in Marketplace",
      detail: "Approved agents receive a publisher key and can be installed.",
      status: hasApproved
        ? "done"
        : hasBlocked
          ? "blocked"
          : hasPending
            ? "active"
            : "idle",
    },
  ];
}

export function developerLaunchStatusLabel(status: DeveloperLaunchStepStatus): string {
  switch (status) {
    case "done":
      return "Done";
    case "active":
      return "Next";
    case "blocked":
      return "Fix";
    case "idle":
      return "Later";
  }
}
