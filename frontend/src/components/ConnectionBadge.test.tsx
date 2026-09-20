import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ConnectionBadge } from "./ConnectionBadge";

describe("ConnectionBadge", () => {
  it("shows the Online label with no pending badge when there's nothing queued", () => {
    render(<ConnectionBadge status="online" pendingCount={0} />);
    expect(screen.getByText("Online")).toBeInTheDocument();
    expect(screen.queryByText(/pending/)).not.toBeInTheDocument();
  });

  it("shows Offline and a pending count when operations are queued", () => {
    render(<ConnectionBadge status="offline" pendingCount={3} />);
    expect(screen.getByText("Offline")).toBeInTheDocument();
    expect(screen.getByText("3 pending")).toBeInTheDocument();
  });

  it("shows the Connecting label while connection is in progress", () => {
    render(<ConnectionBadge status="connecting" pendingCount={1} />);
    expect(screen.getByText("Connecting…")).toBeInTheDocument();
    expect(screen.getByText("1 pending")).toBeInTheDocument();
  });
});
