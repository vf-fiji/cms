import {
  LayoutDashboard, FileText, Files, Newspaper, Image, Images, ClipboardList, LayoutTemplate, Code, CodeXml, Tags, Users, Settings, History, Search,
  Plus, Trash2, Copy, ChevronRight, ChevronDown, ChevronLeft, ExternalLink, Eye, EyeOff, Save, Undo2, Redo2, Monitor, Tablet, Smartphone, Globe, Home,
  GripVertical, MoreHorizontal, Check, X, Upload, FolderOpen, Folder, Pencil, Moon, Sun, LogOut, Bell, Sparkles, Heading, Pilcrow, MousePointerClick,
  PanelTop, SquareStack, LayoutGrid, ChartNoAxesColumn, Quote, GalleryHorizontal, Video, ListCollapse, PanelsTopLeft, MapPin, MoveVertical, Minus,
  Menu, Puzzle, CalendarDays, Zap, Play, Terminal, Webhook, Clock, Server, Database, KeyRound, Shield, ShieldCheck, Lock, ArrowUp, ArrowDown,
  ArrowRight, ArrowLeft, Download, Filter, Star, Columns2, Command, Link, Bold, Italic, Underline, Strikethrough, List, ListOrdered, Heading2, Heading3,
  RemoveFormatting, Palette, Type, Hash, ToggleLeft, Calendar, Mail, Link2, FileCode, Braces, CircleAlert, CircleCheck, Info, LoaderCircle, RotateCcw,
  Send, Inbox, PanelLeft, PanelRight, Layers, Box, Package, ShoppingBag, Briefcase, Trophy, Award, Music, Camera, Map, Heart, Bookmark, BookOpen,
  GraduationCap, Building2, Store, Megaphone, MessageSquare, Phone, CircleHelp, WandSparkles, FilePlus2, FolderPlus, Brush, SquarePen, Atom, Wind, type LucideIcon,
} from "lucide-react";

export const ICONS: Record<string, LucideIcon> = {
  LayoutDashboard, FileText, Files, Newspaper, Image, Images, ClipboardList, LayoutTemplate, Code, CodeXml, Tags, Users, Settings, History, Search,
  Plus, Trash2, Copy, ChevronRight, ChevronDown, ChevronLeft, ExternalLink, Eye, EyeOff, Save, Undo2, Redo2, Monitor, Tablet, Smartphone, Globe, Home,
  GripVertical, MoreHorizontal, Check, X, Upload, FolderOpen, Folder, Pencil, Moon, Sun, LogOut, Bell, Sparkles, Heading, Pilcrow, MousePointerClick,
  PanelTop, SquareStack, LayoutGrid, ChartNoAxesColumn, Quote, GalleryHorizontal, Video, ListCollapse, PanelsTopLeft, MapPin, MoveVertical, Minus,
  Menu, Puzzle, CalendarDays, Zap, Play, Terminal, Webhook, Clock, Server, Database, KeyRound, Shield, ShieldCheck, Lock, ArrowUp, ArrowDown,
  ArrowRight, ArrowLeft, Download, Filter, Star, Columns2, Command, Link, Bold, Italic, Underline, Strikethrough, List, ListOrdered, Heading2, Heading3,
  RemoveFormatting, Palette, Type, Hash, ToggleLeft, Calendar, Mail, Link2, FileCode, Braces, CircleAlert, CircleCheck, Info, LoaderCircle, RotateCcw,
  Send, Inbox, PanelLeft, PanelRight, Layers, Box, Package, ShoppingBag, Briefcase, Trophy, Award, Music, Camera, Map, Heart, Bookmark, BookOpen,
  GraduationCap, Building2, Store, Megaphone, MessageSquare, Phone, CircleHelp, WandSparkles, FilePlus2, FolderPlus, Brush, SquarePen, Atom, Wind,
};

/** Icons offered in the content-type and widget icon pickers. */
export const PICKER_ICONS = [
  "FileText", "Newspaper", "CalendarDays", "Users", "Image", "Video", "ShoppingBag", "Package", "Briefcase", "Trophy", "Award", "Music", "Camera", "Map",
  "MapPin", "Heart", "Star", "Bookmark", "BookOpen", "GraduationCap", "Building2", "Store", "Megaphone", "MessageSquare", "Phone", "CircleHelp", "Box",
  "Layers", "Puzzle", "Atom", "Zap", "Globe", "Tags", "Mail", "Quote", "LayoutGrid", "SquareStack",
];

export function Icon({ name, size = 16, className, strokeWidth }: { name: string; size?: number; className?: string; strokeWidth?: number }) {
  const C = ICONS[name] ?? ICONS.Box;
  return <C size={size} className={className} strokeWidth={strokeWidth ?? 1.9} aria-hidden="true" />;
}
