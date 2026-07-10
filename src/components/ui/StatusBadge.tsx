import { forwardRef } from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Chip from "@mui/material/Chip";

export interface StatusBadgeProps {
  status: "online" | "offline" | "warning" | "error" | "loading";
  label?: string;
  size?: "small" | "medium";
  showDot?: boolean;
}

const statusColors = {
  online: "success",
  offline: "default",
  warning: "warning",
  error: "error",
  loading: "info",
} as const;

const StatusBadge = forwardRef<HTMLDivElement, StatusBadgeProps>(
  ({ status, label, size = "medium", showDot = true }, ref) => {
    const color = statusColors[status];

    return (
      <Box ref={ref} sx={{ display: "inline-flex", alignItems: "center", gap: 1 }}>
        {showDot && (
          <Box
            sx={{
              width: size === "small" ? 6 : 8,
              height: size === "small" ? 6 : 8,
              borderRadius: "50%",
              backgroundColor: `${color}.main`,
              animation: status === "loading" ? "pulse 1.5s infinite" : "none",
              "@keyframes pulse": {
                "0%": {
                  opacity: 1,
                },
                "50%": {
                  opacity: 0.5,
                },
                "100%": {
                  opacity: 1,
                },
              },
            }}
          />
        )}
        {label ? (
          <Chip label={label} color={color} size={size} />
        ) : (
          <Typography
            variant={size === "small" ? "caption" : "body2"}
            color={`${color}.main`}
            sx={{ textTransform: "capitalize" }}
          >
            {status}
          </Typography>
        )}
      </Box>
    );
  }
);

StatusBadge.displayName = "StatusBadge";

export default StatusBadge;
