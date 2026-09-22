import type { RemixiconComponentType } from "@remixicon/react";
import { useEffect, useRef } from "react";

export interface HubContextMenuItem {
	label: string;
	icon?: RemixiconComponentType;
	action: () => void;
	danger?: boolean;
}

export interface HubContextMenuProps {
	x: number;
	y: number;
	onClose: () => void;
	items: HubContextMenuItem[];
}

export function HubContextMenu({ x, y, onClose, items }: HubContextMenuProps) {
	const menuRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const handleClickOutside = (e: MouseEvent) => {
			if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
				onClose();
			}
		};

		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				onClose();
			}
		};

		document.addEventListener("mousedown", handleClickOutside);
		document.addEventListener("keydown", handleKeyDown);
		return () => {
			document.removeEventListener("mousedown", handleClickOutside);
			document.removeEventListener("keydown", handleKeyDown);
		};
	}, [onClose]);

	// Viewport boundary check
	const menuWidth = 200;
	const menuHeight = items.length * 36 + 16;
	const adjustedX = Math.min(
		x,
		(typeof window !== "undefined" ? window.innerWidth : 1000) - menuWidth - 16,
	);
	const adjustedY = Math.min(
		y,
		(typeof window !== "undefined" ? window.innerHeight : 1000) - menuHeight - 16,
	);

	return (
		<div
			ref={menuRef}
			data-testid="hub-context-menu"
			style={{ top: `${adjustedY}px`, left: `${adjustedX}px` }}
			className="fixed z-50 min-w-48 overflow-hidden rounded-[var(--radius-sm)] border border-border-default bg-container-elevated-bg p-4 shadow-md backdrop-blur-md"
		>
			<div className="flex flex-col gap-2">
				{items.map((item, idx) => {
					const Icon = item.icon;
					return (
						<button
							key={item.label}
							type="button"
							data-testid={`hub-context-item-${idx}`}
							onClick={() => {
								item.action();
								onClose();
							}}
							className={`flex w-full items-center gap-8 rounded-[var(--radius-sm)] px-8 py-4 text-left tr-text-action transition-colors ${
								item.danger
									? "text-feedback-error hover:bg-feedback-error-subtle"
									: "text-text-default hover:bg-control-bg-hovered"
							}`}
						>
							{Icon && <Icon className="size-16 shrink-0 opacity-80" />}
							<span className="truncate">{item.label}</span>
						</button>
					);
				})}
			</div>
		</div>
	);
}
