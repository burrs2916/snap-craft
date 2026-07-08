import { forwardRef } from "react";
import Card from "@mui/material/Card";
import CardHeader from "@mui/material/CardHeader";
import CardContent from "@mui/material/CardContent";
import CardActions from "@mui/material/CardActions";
import IconButton from "@mui/material/IconButton";
import Typography from "@mui/material/Typography";
import MoreVertIcon from "@mui/icons-material/MoreVert";

export interface InfoCardProps {
  title: string;
  subheader?: string;
  icon?: React.ReactNode;
  actions?: React.ReactNode;
  menuItems?: React.ReactNode;
  children?: React.ReactNode;
  elevation?: number;
}

const InfoCard = forwardRef<HTMLDivElement, InfoCardProps>(
  (
    {
      title,
      subheader,
      icon,
      actions,
      menuItems,
      children,
      elevation = 1,
    },
    ref
  ) => {
    return (
      <Card ref={ref} elevation={elevation}>
        <CardHeader
          avatar={icon}
          action={
            menuItems && (
              <IconButton aria-label="settings">
                <MoreVertIcon />
              </IconButton>
            )
          }
          title={<Typography variant="h6">{title}</Typography>}
          subheader={subheader}
        />
        {children && <CardContent>{children}</CardContent>}
        {actions && <CardActions>{actions}</CardActions>}
      </Card>
    );
  }
);

InfoCard.displayName = "InfoCard";

export default InfoCard;
