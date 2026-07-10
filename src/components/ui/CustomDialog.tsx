import { forwardRef } from "react";
import Dialog, { DialogProps } from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import DialogActions from "@mui/material/DialogActions";
import IconButton from "@mui/material/IconButton";
import Typography from "@mui/material/Typography";
import CloseIcon from "@mui/icons-material/Close";

export interface CustomDialogProps extends Omit<DialogProps, "title"> {
  title?: string;
  showCloseButton?: boolean;
  actions?: React.ReactNode;
}

const CustomDialog = forwardRef<HTMLDivElement, CustomDialogProps>(
  (
    { title, showCloseButton = true, actions, children, onClose, ...props },
    ref
  ) => {
    return (
      <Dialog ref={ref} onClose={onClose} {...props}>
        {title && (
          <DialogTitle sx={{ m: 0, p: 2 }}>
            <Typography variant="h6">{title}</Typography>
            {showCloseButton && onClose && (
              <IconButton
                aria-label="close"
                onClick={(e) => onClose(e, "backdropClick")}
                sx={{
                  position: "absolute",
                  right: 8,
                  top: 8,
                  color: (theme) => theme.palette.grey[500],
                }}
              >
                <CloseIcon />
              </IconButton>
            )}
          </DialogTitle>
        )}
        <DialogContent dividers>{children}</DialogContent>
        {actions && <DialogActions>{actions}</DialogActions>}
      </Dialog>
    );
  }
);

CustomDialog.displayName = "CustomDialog";

export default CustomDialog;
