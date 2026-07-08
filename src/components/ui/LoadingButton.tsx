import { forwardRef } from "react";
import Button, { ButtonProps } from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Box from "@mui/material/Box";

export interface LoadingButtonProps extends ButtonProps {
  loading?: boolean;
}

const LoadingButton = forwardRef<HTMLButtonElement, LoadingButtonProps>(
  ({ loading, children, disabled, startIcon, ...props }, ref) => {
    return (
      <Button
        ref={ref}
        disabled={disabled || loading}
        startIcon={
          loading ? (
            <Box sx={{ display: "flex", alignItems: "center" }}>
              <CircularProgress size={16} color="inherit" />
            </Box>
          ) : (
            startIcon
          )
        }
        {...props}
      >
        {children}
      </Button>
    );
  }
);

LoadingButton.displayName = "LoadingButton";

export default LoadingButton;
