import type { CSSProperties, ReactNode } from "react";
import { AVATARS, teamDisplayName, type PublicPlayer, type PublicTeam } from "../../shared/types";
import type { ConnStatus } from "./net";

export function ConnectionBanner({ status }: { status: ConnStatus }) {
  if (status === "open") return null;
  return (
    <div className="conn-banner" role="status">
      {status === "connecting" ? "Connecting…" : "Reconnecting… your place is saved."}
    </div>
  );
}

export function teamStyle(team: Pick<PublicTeam, "colour">): CSSProperties {
  return { "--team": team.colour } as CSSProperties;
}

interface TeamCardProps {
  team: PublicTeam;
  players: Map<string, PublicPlayer>;
  /** Show empty seats for members not revealed yet. */
  showSeats?: boolean;
  highlightId?: string | null;
  size?: "md" | "lg";
  footer?: ReactNode;
}

export function TeamCard({ team, players, showSeats, highlightId, size = "md", footer }: TeamCardProps) {
  const seats = showSeats ? Math.max(0, team.memberCount - team.memberIds.length) : 0;
  return (
    <article className={`team-card team-card--${size}`} style={teamStyle(team)}>
      <header className="team-card__head">
        <span className="team-card__badge" aria-hidden>
          {team.badge}
        </span>
        <h3 className={`team-card__name${team.name ? "" : " team-card__name--pending"}`}>{teamDisplayName(team)}</h3>
      </header>
      <ul className="team-card__members">
        {team.memberIds.map((id) => {
          const p = players.get(id);
          if (!p) return null;
          return (
            <li key={id} className={`member${id === highlightId ? " member--new" : ""}${p.status === "left" ? " member--left" : ""}`}>
              <span className="member__emoji" aria-hidden>
                {p.emoji}
              </span>
              {p.name}
            </li>
          );
        })}
        {Array.from({ length: seats }, (_, i) => (
          <li key={`seat-${i}`} className="member member--seat">
            <span className="member__emoji" aria-hidden>
              ?
            </span>
            <span className="visually-hidden">Not drawn yet</span>
          </li>
        ))}
      </ul>
      {team.motto && <p className="team-card__motto">“{team.motto}”</p>}
      {footer}
    </article>
  );
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function AvatarPicker({ value, onChange }: { value: string; onChange: (emoji: string) => void }) {
  return (
    <div className="avatar-grid" role="radiogroup" aria-label="Choose your avatar">
      {AVATARS.map((a) => (
        <button
          key={a}
          type="button"
          role="radio"
          aria-checked={value === a}
          className={`avatar-grid__item${value === a ? " is-selected" : ""}`}
          onClick={() => onChange(a)}
        >
          {a}
        </button>
      ))}
    </div>
  );
}

export function playerMap(players: PublicPlayer[]): Map<string, PublicPlayer> {
  return new Map(players.map((p) => [p.id, p]));
}

export function Wordmark({ className = "" }: { className?: string }) {
  return <span className={`wordmark ${className}`}>Friendsmas</span>;
}
