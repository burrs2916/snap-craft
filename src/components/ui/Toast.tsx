import { forwardRef } from "react";
import Alert, { AlertProps } from "@mui/material/Alert";
import Snackbar, { SnackbarProps } from "@mui/material/Snackbar";

export interface ToastProps {
  open: boolean;
  message: string;
  severity?: AlertProps["severity"];
  duration?: number;
  onClose: () => void;
  anchorOrigin?: SnackbarProps["anchorOrigin"];
}

const Toast = forwardRef<HTMLDivElement, ToastProps>(
  (
    {
      open,
      message,
      severity = "info",
      duration = 4000,
      onClose,
      anchorOrigin = { vertical: "bottom", horizontal: "center" },
    },
    ref
  ) => {
    return (
      <Snackbar
        ref={ref}
        open={open}
        autoHideDuration={duration}
        onClose={onClose}
        anchorOrigin={anchorOrigin}
      >
        <Alert
          onClose={onClose}
          severity={severity}
          variant="filled"
          sx={{ width: "100%" }}
        >
          {message}
        </Alert>
      </Snackbar>
    );
  }
);

Toast.displayName = "Toast";

export default Toast;
