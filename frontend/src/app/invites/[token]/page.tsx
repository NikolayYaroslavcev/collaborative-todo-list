"use client";

import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { api, ApiError } from "@/lib/api";
import { AppShell } from "@/components/AppShell";
import { ErrorState, LoadingState } from "@/components/StateViews";

export default function AcceptInvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token: inviteToken } = use(params);
  const { token, isLoading: authLoading } = useAuth();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(false);

  useEffect(() => {
    if (authLoading) return;
    if (!token) {
      router.replace(`/login?next=${encodeURIComponent(`/invites/${inviteToken}`)}`);
      return;
    }
    let cancelled = false;
    api
      .acceptInvite(token, inviteToken)
      .then(({ listId }) => {
        if (cancelled) return;
        setAccepted(true);
        router.replace(`/lists/${listId}`);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : "This invite link is no longer valid.");
      });
    return () => {
      cancelled = true;
    };
  }, [authLoading, token, inviteToken, router]);

  return (
    <AppShell>
      {error ? (
        <ErrorState message={error} />
      ) : (
        <LoadingState label={accepted ? "Joined — taking you to the list…" : "Joining list…"} />
      )}
    </AppShell>
  );
}
