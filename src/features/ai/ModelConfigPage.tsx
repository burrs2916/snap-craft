import { useState, useEffect, useCallback } from 'react';
import {
  Box, TextField, Button, Typography, Switch, FormControlLabel,
  Dialog, DialogTitle, DialogContent, DialogActions,
  IconButton, Chip, Tooltip, Card, Collapse, Divider,
  Alert, Snackbar, CircularProgress, MenuItem, Select, FormControl, InputLabel, Menu,
  InputAdornment,
} from '@mui/material';
import {
  PlusIcon,
  PencilSimpleIcon,
  TrashIcon,
  CloudIcon,
  PlugsIcon,
  RobotIcon,
  CheckCircleIcon,
  WarningIcon,
  PlayIcon,
  CaretDownIcon,
  CaretUpIcon,
  EyeIcon,
  EyeSlashIcon,
} from '@phosphor-icons/react';
import { useAgentStore, genId } from './agentStore';
import { useAiStore } from './aiStore';
import type { AiProviderConfig, AiEndpointConfig, AiModelConfig } from './aiTypes';
import { t } from '../../i18n';
import { getProvider } from './providers';
import { VISION_NAME_HINTS, modelChatUsable } from './providerConfig';
import { useTheme, ThemeProvider, createTheme } from '@mui/material/styles';

// 注意：biosphere 的 API 类型取值为 openai-completions / anthropic-messages / ollama /
// openai-responses，而 snap-craft 的 AiApiType 仅区分 'openai' | 'anthropic'（aiClient 据此
// 拼装请求与鉴权）。此处对齐 snap-craft 的取值，保证写入的 endpoint.apiType 可被 aiClient 正确使用。
const API_TYPE_KEYS: { value: string; labelKey: string }[] = [
  { value: 'openai', labelKey: 'api.type_openai' },
  { value: 'anthropic', labelKey: 'api.type_anthropic' },
];

const AUTH_TYPE_KEYS: { value: string; labelKey: string }[] = [
  { value: 'bearer', labelKey: 'api.auth_type_bearer' },
  { value: 'x-api-key', labelKey: 'api.auth_type_x_api_key' },
  { value: 'custom-header', labelKey: 'api.auth_type_custom' },
];

// 快速添加预设：国际大厂 + 本地框架 Ollama（必须支持），其余供应商由用户自行「自定义」添加，避免过多无用预设
const PROVIDER_PRESETS = [
  { id: 'openai', nameKey: 'preset.openai', logo: '🟢' },
  { id: 'anthropic', nameKey: 'preset.anthropic', logo: '🟠' },
  { id: 'google', nameKey: 'preset.google', logo: '🟡' },
  { id: 'ollama', nameKey: 'preset.ollama', logo: '🦙' },
];

/** 供应商名兼容：老数据 name 可能存的是 i18n key（如 'ai.providerDeepSeek'），含 '.' 则经 t() 解析为展示名 */
const displayProviderName = (name: string): string => (name.includes('.') ? t(name) : name);

/// 从字符串生成确定性颜色（相同名称永远得到相同颜色）
const PROVIDER_COLORS = [
  '#6C63FF', '#4FC3F7', '#00E676', '#FFD740', '#FF6B6B',
  '#26C6DA', '#AB47BC', '#FFA726', '#66BB6A', '#5C6BC0',
  '#EC407A', '#7E57C2', '#29B6F6', '#9CCC65', '#8D6E63',
];

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function getProviderColor(name: string): string {
  return PROVIDER_COLORS[hashString(name || '?') % PROVIDER_COLORS.length];
}

/// 供应商颜色圆点：根据名称哈希自动分配颜色，用于视觉区分
function ProviderDot({ name, size = 10 }: { name: string; size?: number }) {
  return (
    <Box
      sx={{
        width: size,
        height: size,
        borderRadius: '50%',
        bgcolor: getProviderColor(name),
        flexShrink: 0,
      }}
    />
  );
}

function localizeBackendError(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  return String(e);
}

/// 跟随 snap-craft 主题（document[data-theme] = light|dark），让 MUI 正确响应明暗
function useIsDark(): boolean {
  const get = () =>
    typeof document !== 'undefined' &&
    document.documentElement.getAttribute('data-theme') === 'dark';
  const [dark, setDark] = useState(get);
  useEffect(() => {
    const el = document.documentElement;
    const obs = new MutationObserver(() => setDark(get()));
    obs.observe(el, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);
  return dark;
}

function ProviderDialog({
  open,
  onClose,
  onSave,
  initial,
}: {
  open: boolean;
  onClose: () => void;
  onSave: (p: AiProviderConfig) => void;
  initial?: AiProviderConfig | null;
}) {
  const [name, setName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    if (initial) {
      setName(initial.name);
      setApiKey(initial.apiKey);
      setEnabled(initial.enabled ?? true);
    } else {
      setName('');
      setApiKey('');
      setEnabled(true);
    }
  }, [initial, open]);

  const handleSave = () => {
    if (!name.trim()) return;
    onSave({
      id: initial?.id || genId('pv'),
      name: name.trim(),
      apiKey: apiKey.trim(),
      enabled,
    });
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{initial ? t('provider.edit') : t('provider.add')}</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: '16px !important' }}>
        <TextField label={t('provider.name')} value={name} onChange={(e) => setName(e.target.value)} fullWidth size="small" placeholder={t('provider.name_placeholder')} />
        <TextField label={t('provider.api_key')} value={apiKey} onChange={(e) => setApiKey(e.target.value)} fullWidth size="small" type={showApiKey ? 'text' : 'password'} placeholder="sk-..." slotProps={{ input: { endAdornment: (<InputAdornment position="end"><IconButton aria-label={t('provider.toggle_password_visibility')} onClick={() => setShowApiKey((v) => !v)} edge="end" size="small">{showApiKey ? <EyeSlashIcon size={18} /> : <EyeIcon size={18} />}</IconButton></InputAdornment>) } }} />
        <FormControlLabel control={<Switch checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />} label={t('agent.enabled')} />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('dialog.cancel')}</Button>
        <Button onClick={handleSave} variant="contained" disabled={!name.trim()}>{t('dialog.save')}</Button>
      </DialogActions>
    </Dialog>
  );
}

function EndpointDialog({
  open,
  onClose,
  onSave,
  initial,
  providerId,
}: {
  open: boolean;
  onClose: () => void;
  onSave: (e: AiEndpointConfig) => void;
  initial?: AiEndpointConfig | null;
  providerId: string;
}) {
  const [name, setName] = useState('');
  const [apiType, setApiType] = useState('openai');
  const [baseUrl, setBaseUrl] = useState('');
  const [authType, setAuthType] = useState('bearer');
  const [customAuthHeader, setCustomAuthHeader] = useState('');
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    if (initial) {
      setName(initial.name);
      setApiType(initial.apiType);
      setBaseUrl(initial.baseUrl);
      setAuthType(initial.authType);
      setCustomAuthHeader(initial.customAuthHeader ?? '');
      setEnabled(initial.enabled ?? true);
    } else {
      setName('');
      setApiType('openai');
      setBaseUrl('');
      setAuthType('bearer');
      setCustomAuthHeader('');
      setEnabled(true);
    }
  }, [initial, open]);

  useEffect(() => {
    if (!initial && open) {
      if (apiType === 'anthropic') {
        setAuthType('x-api-key');
      } else {
        setAuthType('bearer');
      }
    }
  }, [apiType, initial, open]);

  const handleSave = () => {
    if (!name.trim()) return;
    onSave({
      id: initial?.id || genId('ep'),
      providerId,
      name: name.trim(),
      apiType: apiType as AiEndpointConfig['apiType'],
      baseUrl: baseUrl.trim(),
      authType: authType as AiEndpointConfig['authType'],
      customAuthHeader: customAuthHeader.trim(),
      enabled,
    });
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{initial ? t('endpoint.edit') : t('endpoint.add')}</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: '16px !important' }}>
        <TextField label={t('endpoint.name')} value={name} onChange={(e) => setName(e.target.value)} fullWidth size="small" placeholder={t('endpoint.name_placeholder')} />
        <FormControl size="small" fullWidth>
          <InputLabel>{t('api.type_label')}</InputLabel>
          <Select value={apiType} label={t('api.type_label')} onChange={(e) => setApiType(e.target.value)}>
            {API_TYPE_KEYS.map((o) => (
              <MenuItem key={o.value} value={o.value}>{t(o.labelKey)}</MenuItem>
            ))}
          </Select>
        </FormControl>
        <TextField label={t('provider.base_url')} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} fullWidth size="small" placeholder="https://api.openai.com/v1/" />
        <FormControl size="small" fullWidth>
          <InputLabel>{t('api.auth_type')}</InputLabel>
          <Select value={authType} label={t('api.auth_type')} onChange={(e) => setAuthType(e.target.value)}>
            {AUTH_TYPE_KEYS.map((o) => (
              <MenuItem key={o.value} value={o.value}>{t(o.labelKey)}</MenuItem>
            ))}
          </Select>
        </FormControl>
        {authType === 'custom-header' && (
          <TextField label={t('api.custom_auth_header')} value={customAuthHeader} onChange={(e) => setCustomAuthHeader(e.target.value)} fullWidth size="small" placeholder="X-Custom-Auth" />
        )}
        <FormControlLabel control={<Switch checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />} label={t('agent.enabled')} />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('dialog.cancel')}</Button>
        <Button onClick={handleSave} variant="contained" disabled={!name.trim()}>{t('dialog.save')}</Button>
      </DialogActions>
    </Dialog>
  );
}

function ModelDialog({
  open,
  onClose,
  onSave,
  initial,
  endpointId,
}: {
  open: boolean;
  onClose: () => void;
  onSave: (m: AiModelConfig) => void;
  initial?: AiModelConfig | null;
  endpointId: string;
}) {
  const [name, setName] = useState('');
  const [refKey, setRefKey] = useState('');
  const [reasoning, setReasoning] = useState(false);
  const [contextWindow, setContextWindow] = useState(128000);
  const [maxTokens, setMaxTokens] = useState(4096);
  const [inputTypes, setInputTypes] = useState<string[]>(['text']);
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    if (initial) {
      setName(initial.name);
      setRefKey(initial.refKey);
      setReasoning(initial.reasoning ?? false);
      setContextWindow(initial.contextWindow ?? 128000);
      setMaxTokens(initial.maxTokens ?? 4096);
      setInputTypes(initial.inputTypes);
      setEnabled(initial.enabled ?? true);
    } else {
      setName('');
      setRefKey('');
      setReasoning(false);
      setContextWindow(128000);
      setMaxTokens(4096);
      setInputTypes(['text']);
      setEnabled(true);
    }
  }, [initial, open]);

  const handleSave = () => {
    if (!name.trim() || !refKey.trim()) return;
    onSave({
      id: initial?.id || genId('model'),
      name: name.trim(),
      refKey: refKey.trim(),
      endpointId,
      reasoning,
      inputTypes: inputTypes as AiModelConfig['inputTypes'],
      contextWindow,
      maxTokens,
      enabled,
    });
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{initial ? t('model.edit') : t('model.add')}</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: '16px !important' }}>
        <TextField label={t('model.name')} value={name} onChange={(e) => setName(e.target.value)} fullWidth size="small" placeholder={t('model.name_placeholder')} />
        <TextField label={t('model.ref_key')} value={refKey} onChange={(e) => {
          const v = e.target.value;
          setRefKey(v);
          // 按已知视觉模型名预勾选「支持图片」：用户填了带视觉特征的模型名即自动开启图片能力
          if (VISION_NAME_HINTS.some((h) => v.toLowerCase().includes(h)) && !inputTypes.includes('image')) {
            setInputTypes([...inputTypes, 'image']);
          }
        }} fullWidth size="small" placeholder={t('model.ref_key_placeholder')} helperText={t('model.ref_key_helper')} />
        <Box sx={{ display: 'flex', gap: 2 }}>
          <TextField label={t('model.context_window')} value={contextWindow} onChange={(e) => setContextWindow(Number(e.target.value))} size="small" type="number" sx={{ flex: 1 }} />
          <TextField label={t('model.max_tokens')} value={maxTokens} onChange={(e) => setMaxTokens(Number(e.target.value))} size="small" type="number" sx={{ flex: 1 }} />
        </Box>
        <Box sx={{ display: 'flex', gap: 2, alignItems: 'center' }}>
          <FormControlLabel control={<Switch checked={reasoning} onChange={(e) => setReasoning(e.target.checked)} />} label={t('model.reasoning_model')} />
          <FormControlLabel control={<Switch checked={inputTypes.includes('image')} onChange={(e) => {
            if (e.target.checked) {
              setInputTypes([...inputTypes, 'image']);
            } else {
              setInputTypes(inputTypes.filter((x) => x !== 'image'));
            }
          }} />} label={t('model.support_image')} />
        </Box>
        <FormControlLabel control={<Switch checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />} label={t('agent.enabled')} />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('dialog.cancel')}</Button>
        <Button onClick={handleSave} variant="contained" disabled={!name.trim() || !refKey.trim()}>{t('dialog.save')}</Button>
      </DialogActions>
    </Dialog>
  );
}

function ConfirmDialog({
  open,
  title,
  message,
  onConfirm,
  onCancel,
  cancelLabel,
  confirmLabel,
}: {
  open: boolean;
  title: string;
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
  cancelLabel: string;
  confirmLabel: string;
}) {
  return (
    <Dialog open={open} onClose={onCancel} maxWidth="xs" fullWidth>
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        <Typography variant="body2">{message}</Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel}>{cancelLabel}</Button>
        <Button onClick={onConfirm} variant="contained" color="error">{confirmLabel}</Button>
      </DialogActions>
    </Dialog>
  );
}

export function ModelConfigPage() {
  const isDark = useIsDark();
  return (
    <ThemeProvider theme={createTheme({ palette: { mode: isDark ? 'dark' : 'light' } })}>
      <ModelConfigPageInner />
    </ThemeProvider>
  );
}

function ModelConfigPageInner() {
  const theme = useTheme();
  const isDark = theme.palette.mode === 'dark';
  const primaryColor = isDark ? '#6C63FF' : '#5B54E0';
  const cardBorder = isDark ? 'rgba(48,54,61,0.6)' : 'rgba(0,0,0,0.08)';
  const cardBg = isDark ? 'rgba(22,27,34,0.6)' : 'rgba(255,255,255,0.8)';
  const innerCardBg = isDark ? 'rgba(13,17,23,0.6)' : 'rgba(245,245,245,0.6)';
  const hoverBg = isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.03)';
  const hoverBg2 = isDark ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.02)';
  const errorColor = isDark ? '#FF5252' : '#D32F2F';
  const successColor = isDark ? '#00E676' : '#2E7D32';
  const disabledColor = isDark ? '#555' : '#9E9E9E';
  const config = useAiStore((s) => s.config);
  const {
    providers,
    endpoints,
    models,
    saveProvider,
    deleteProvider,
    saveEndpoint,
    deleteEndpoint,
    saveModel,
    deleteModel,
    testEndpointConnection,
    testModelChat,
    agents,
  } = useAgentStore();

  const [providerDialog, setProviderDialog] = useState<{ open: boolean; data: AiProviderConfig | null }>({ open: false, data: null });
  const [endpointDialog, setEndpointDialog] = useState<{ open: boolean; data: AiEndpointConfig | null; providerId: string }>({ open: false, data: null, providerId: '' });
  const [modelDialog, setModelDialog] = useState<{ open: boolean; data: AiModelConfig | null; endpointId: string }>({ open: false, data: null, endpointId: '' });
  const [deleteConfirm, setDeleteConfirm] = useState<{ open: boolean; title: string; message: string; onConfirm: () => void }>({ open: false, title: '', message: '', onConfirm: () => {} });
  const [snackbar, setSnackbar] = useState<{ open: boolean; message: string; severity: 'success' | 'error' }>({ open: false, message: '', severity: 'success' });
  const [testResults, setTestResults] = useState<Map<string, { success: boolean; message: string }>>(new Map());
  const [testingId, setTestingId] = useState<string | null>(null);
  const [modelTestResults, setModelTestResults] = useState<Map<string, { success: boolean; message: string }>>(new Map());
  const [testingModelId, setTestingModelId] = useState<string | null>(null);
  const [expandedProviders, setExpandedProviders] = useState<Set<string>>(new Set(providers.map((p) => p.id)));
  const [expandedEndpoints, setExpandedEndpoints] = useState<Set<string>>(new Set());
  const [presetAnchor, setPresetAnchor] = useState<HTMLElement | null>(null);

  const toggleProvider = useCallback((id: string) => {
    setExpandedProviders((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleEndpoint = useCallback((id: string) => {
    setExpandedEndpoints((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleTestConnection = useCallback(async (endpointId: string) => {
    setTestingId(endpointId);
    try {
      const result = await testEndpointConnection(endpointId);
      setTestResults((prev) => {
        const next = new Map(prev);
        next.set(endpointId, { success: true, message: result });
        return next;
      });
      setSnackbar({ open: true, message: result, severity: 'success' });
    } catch (e) {
      setTestResults((prev) => {
        const next = new Map(prev);
        next.set(endpointId, { success: false, message: localizeBackendError(e) });
        return next;
      });
      setSnackbar({ open: true, message: localizeBackendError(e), severity: 'error' });
    } finally {
      setTestingId(null);
    }
  }, [testEndpointConnection]);

  const handleTestModel = useCallback(async (modelId: string) => {
    setTestingModelId(modelId);
    try {
      const result = await testModelChat(modelId);
      setModelTestResults((prev) => {
        const next = new Map(prev);
        next.set(modelId, { success: true, message: result });
        return next;
      });
      setSnackbar({ open: true, message: result, severity: 'success' });
    } catch (e) {
      setModelTestResults((prev) => {
        const next = new Map(prev);
        next.set(modelId, { success: false, message: localizeBackendError(e) });
        return next;
      });
      setSnackbar({ open: true, message: localizeBackendError(e), severity: 'error' });
    } finally {
      setTestingModelId(null);
    }
  }, [testModelChat]);

  const handleAddPreset = useCallback((preset: { id: string; nameKey: string; logo: string }) => {
    const def = getProvider(preset.id);
    const provider: AiProviderConfig = {
      id: genId('pv'),
      name: t(preset.nameKey),
      apiKey: '',
      enabled: true,
    };
    saveProvider(provider);
    // 完善：按厂商目录预填接入点（接口类型 + 基地址 + 鉴权），用户只需填密钥与模型
    if (def) {
      saveEndpoint({
        id: genId('ep'),
        providerId: provider.id,
        name: '',
        apiType: def.apiType,
        baseUrl: def.baseUrl,
        authType: def.apiType === 'anthropic' ? 'x-api-key' : 'bearer',
      });
    }
    setExpandedProviders((prev) => new Set(prev).add(provider.id));
    setPresetAnchor(null);
    setSnackbar({ open: true, message: `${t('config.provider_added')}: ${t(preset.nameKey)}`, severity: 'success' });
  }, [saveProvider, saveEndpoint, t]);

  const getEndpointsForProvider = useCallback((providerId: string) => {
    return endpoints.filter((e) => e.providerId === providerId);
  }, [endpoints]);

  const getModelsForEndpoint = useCallback((endpointId: string) => {
    return models.filter((m) => m.endpointId === endpointId);
  }, [models]);

  const getApiTypeLabel = (apiType: string) => {
    const key = API_TYPE_KEYS.find((o) => o.value === apiType)?.labelKey;
    return key ? t(key) : apiType;
  };

  return (
    <Box sx={{ p: 2, height: '100%', width: '100%', overflow: 'auto', minWidth: 0, minHeight: 0 }}>
      <Box sx={{ mb: 2, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Box>
          <Typography variant="caption" color="text.secondary">
            {t('config.model_config_desc')}
          </Typography>
        </Box>
        <Box sx={{ display: 'flex', gap: 1 }}>
          <Button
            size="small"
            variant="outlined"
            startIcon={<CloudIcon size={14} />}
            onClick={(e) => setPresetAnchor(e.currentTarget)}
            sx={{ borderRadius: 2, fontSize: 11 }}
          >
            {t('config.quick_add')}
          </Button>
          <Button
            size="small"
            variant="contained"
            startIcon={<PlusIcon size={14} weight="bold" />}
            onClick={() => setProviderDialog({ open: true, data: null })}
            sx={{ borderRadius: 2, fontSize: 11, background: `linear-gradient(135deg, ${primaryColor} 0%, ${isDark ? '#8B83FF' : '#7B75FF'} 100%)` }}
          >
            {t('provider.add')}
          </Button>
        </Box>
      </Box>

      <Menu
        open={Boolean(presetAnchor)}
        anchorEl={presetAnchor}
        onClose={() => setPresetAnchor(null)}
      >
        {PROVIDER_PRESETS.map((preset) => (
          <MenuItem key={preset.nameKey} onClick={() => handleAddPreset(preset)}>
            <ProviderDot name={t(preset.nameKey)} size={10} />
            <Box sx={{ ml: 1.5 }} />
            {t(preset.nameKey)}
          </MenuItem>
        ))}
      </Menu>

      {providers.length === 0 ? (
        <Card sx={{ border: 1, borderColor: 'divider', borderRadius: 2, textAlign: 'center', py: 6, bgcolor: 'rgba(22,27,34,0.6)' }}>
          <CloudIcon size={48} color="#555" style={{ marginBottom: 8 }} />
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            {t('config.no_provider')}
          </Typography>
          <Typography variant="caption" color="text.disabled" sx={{ mb: 2, display: 'block' }}>
            {t('config.no_provider_desc')}
          </Typography>
          <Button variant="outlined" size="small" startIcon={<PlusIcon size={14} weight="bold" />} onClick={() => setProviderDialog({ open: true, data: null })} sx={{ borderRadius: 2 }}>
            {t('provider.add')}
          </Button>
        </Card>
      ) : (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          {providers.map((provider) => {
            const providerEndpoints = getEndpointsForProvider(provider.id);
            const isExpanded = expandedProviders.has(provider.id);

            return (
              <Card key={provider.id} sx={{ border: 1, borderColor: cardBorder, borderRadius: 2, bgcolor: cardBg, overflow: 'visible' }}>
                <Box
                  sx={{
                    p: 1.5,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    cursor: 'pointer',
                    '&:hover': { bgcolor: hoverBg },
                  }}
                  onClick={() => toggleProvider(provider.id)}
                >
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <ProviderDot name={provider.name} size={10} />
                    <Box>
                      <Typography variant="body2" sx={{ fontWeight: 600 }}>{displayProviderName(provider.name)}</Typography>
                      <Box sx={{ display: 'flex', gap: 0.5, alignItems: 'center' }}>
                        <Chip label={`${providerEndpoints.length} ${t('endpoint.count')}`} size="small" variant="outlined" sx={{ fontSize: 9, height: 18 }} />
                        <Chip
                          label={provider.enabled ? t('agent.enabled') : t('agent.disabled')}
                          size="small"
                          color={provider.enabled ? 'success' : 'default'}
                          sx={{ fontSize: 9, height: 18 }}
                        />
                      </Box>
                    </Box>
                  </Box>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.25 }} onClick={(e) => e.stopPropagation()}>
                    <Tooltip title={t('provider.edit')}>
                      <IconButton size="small" onClick={() => setProviderDialog({ open: true, data: provider })}>
                        <PencilSimpleIcon size={14} />
                      </IconButton>
                    </Tooltip>
                    <Tooltip title={t('provider.delete')}>
                      <IconButton size="small" onClick={() => {
                        const providerModels = models.filter(m =>
                          endpoints.some(e => e.providerId === provider.id && e.id === m.endpointId)
                        ).map(m => m.id);
                        const affectedAgents = agents.filter(a =>
                          (a.modelId && providerModels.includes(a.modelId)) ||
                          (a.fallbackModelId && providerModels.includes(a.fallbackModelId))
                        );
                        let msg = t('provider.delete_confirm', { name: displayProviderName(provider.name) });
                        if (affectedAgents.length > 0) {
                          msg += '\n\n' + t('provider.delete_affected_agents', {
                            count: affectedAgents.length,
                            names: affectedAgents.map(a => a.name).join(', '),
                            defaultValue: `This will affect ${affectedAgents.length} agent(s): ${affectedAgents.map(a => a.name).join(', ')}`,
                          });
                        }
                        setDeleteConfirm({
                          open: true,
                          title: t('provider.delete'),
                          message: msg,
                          onConfirm: async () => {
                            await deleteProvider(provider.id);
                            setDeleteConfirm({ open: false, title: '', message: '', onConfirm: () => {} });
                          },
                        });
                      }}>
                        <TrashIcon size={14} color={errorColor} />
                      </IconButton>
                    </Tooltip>
                    <IconButton size="small" onClick={() => toggleProvider(provider.id)}>
                      {isExpanded ? <CaretUpIcon size={14} /> : <CaretDownIcon size={14} />}
                    </IconButton>
                  </Box>
                </Box>

                <Collapse in={isExpanded}>
                  <Divider sx={{ borderColor: cardBorder }} />
                  <Box sx={{ p: 1.5 }}>
                    <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
                      <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600 }}>
                        {t('endpoint.label')}
                      </Typography>
                      <Button
                        size="small"
                        startIcon={<PlusIcon size={12} weight="bold" />}
                        onClick={() => setEndpointDialog({ open: true, data: null, providerId: provider.id })}
                        sx={{ fontSize: 10, borderRadius: 1.5 }}
                      >
                        {t('endpoint.add')}
                      </Button>
                    </Box>

                    {providerEndpoints.length === 0 ? (
                      <Typography variant="caption" color="text.disabled" sx={{ display: 'block', textAlign: 'center', py: 1.5 }}>
                        {t('endpoint.no_endpoints')}
                      </Typography>
                    ) : (
                      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                        {providerEndpoints.map((endpoint) => {
                          const endpointModels = getModelsForEndpoint(endpoint.id);
                          const isEndpointExpanded = expandedEndpoints.has(endpoint.id);
                          const testResult = testResults.get(endpoint.id);
                          const isTesting = testingId === endpoint.id;

                          return (
                            <Card key={endpoint.id} variant="outlined" sx={{ borderRadius: 1.5, borderColor: cardBorder, bgcolor: innerCardBg }}>
                              <Box
                                sx={{
                                  p: 1,
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'space-between',
                                  cursor: 'pointer',
                                  '&:hover': { bgcolor: hoverBg2 },
                                }}
                                onClick={() => toggleEndpoint(endpoint.id)}
                              >
                                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                                  <PlugsIcon size={14} color="#FFD740" weight="fill" />
                                  <Box>
                                    <Typography variant="caption" sx={{ fontWeight: 600 }}>{endpoint.name}</Typography>
                                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontSize: 9 }}>
                                      {getApiTypeLabel(endpoint.apiType)} · {endpoint.baseUrl || t('endpoint.no_url')}
                                    </Typography>
                                  </Box>
                                </Box>
                                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.25 }} onClick={(e) => e.stopPropagation()}>
                                  {testResult && (
                                    testResult.success
                                      ? <CheckCircleIcon size={12} color={successColor} weight="fill" />
                                      : <WarningIcon size={12} color={errorColor} weight="fill" />
                                  )}
                                  {isTesting && <CircularProgress size={12} />}
                                  <Tooltip title={t('endpoint.test_connection')}>
                                    <IconButton size="small" sx={{ p: 0.25 }} onClick={() => handleTestConnection(endpoint.id)}>
                                      <PlayIcon size={12} />
                                    </IconButton>
                                  </Tooltip>
                                  <Tooltip title={t('endpoint.edit')}>
                                    <IconButton size="small" sx={{ p: 0.25 }} onClick={() => setEndpointDialog({ open: true, data: endpoint, providerId: provider.id })}>
                                      <PencilSimpleIcon size={12} />
                                    </IconButton>
                                  </Tooltip>
                                  <Tooltip title={t('endpoint.delete')}>
                                    <IconButton size="small" sx={{ p: 0.25 }} onClick={() => {
                                      const endpointModels = models.filter(m => m.endpointId === endpoint.id);
                                      const affectedAgents = agents.filter(a =>
                                        endpointModels.some(m => m.id === a.modelId || m.id === a.fallbackModelId)
                                      );
                                      let msg = t('endpoint.delete_confirm', { name: endpoint.name });
                                      if (endpointModels.length > 0) {
                                        msg += '\n\n' + t('endpoint.delete_affected_models', {
                                          count: endpointModels.length,
                                          defaultValue: `This will also delete ${endpointModels.length} model(s) under this endpoint.`,
                                        });
                                      }
                                      if (affectedAgents.length > 0) {
                                        msg += '\n\n' + t('provider.delete_affected_agents', {
                                          count: affectedAgents.length,
                                          names: affectedAgents.map(a => a.name).join(', '),
                                          defaultValue: `This will affect ${affectedAgents.length} agent(s): ${affectedAgents.map(a => a.name).join(', ')}`,
                                        });
                                      }
                                      setDeleteConfirm({
                                        open: true,
                                        title: t('endpoint.delete'),
                                        message: msg,
                                        onConfirm: async () => {
                                          await deleteEndpoint(endpoint.id);
                                          setDeleteConfirm({ open: false, title: '', message: '', onConfirm: () => {} });
                                        },
                                      });
                                    }}>
                                      <TrashIcon size={12} color={errorColor} />
                                    </IconButton>
                                  </Tooltip>
                                  <IconButton size="small" sx={{ p: 0.25 }} onClick={() => toggleEndpoint(endpoint.id)}>
                                    {isEndpointExpanded ? <CaretUpIcon size={12} /> : <CaretDownIcon size={12} />}
                                  </IconButton>
                                </Box>
                              </Box>

                              <Collapse in={isEndpointExpanded}>
                                <Divider sx={{ borderColor: cardBorder }} />
                                <Box sx={{ p: 1 }}>
                                  <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 0.75 }}>
                                    <Typography variant="caption" color="text.secondary">
                                      {t('model.label')} ({endpointModels.length})
                                    </Typography>
                                    <Button
                                      size="small"
                                      startIcon={<PlusIcon size={10} weight="bold" />}
                                      onClick={() => setModelDialog({ open: true, data: null, endpointId: endpoint.id })}
                                      sx={{ fontSize: 9, borderRadius: 1 }}
                                    >
                                      {t('model.add')}
                                    </Button>
                                  </Box>

                                  {endpointModels.length === 0 ? (
                                    <Typography variant="caption" color="text.disabled" sx={{ display: 'block', textAlign: 'center', py: 0.75 }}>
                                      {t('model.no_models')}
                                    </Typography>
                                  ) : (
                                    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
                                      {endpointModels.map((model) => {
                                        const modelTestResult = modelTestResults.get(model.id);
                                        const isModelTesting = testingModelId === model.id;

                                        return (
                                          <Box
                                            key={model.id}
                                            sx={{
                                              p: 0.75,
                                              border: 1,
                                              borderColor: cardBorder,
                                              borderRadius: 1,
                                              display: 'flex',
                                              alignItems: 'center',
                                              justifyContent: 'space-between',
                                              '&:hover': { borderColor: `${primaryColor}80` },
                                            }}
                                          >
                                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, minWidth: 0, flex: 1 }}>
                                              <RobotIcon size={12} color={model.enabled ? primaryColor : disabledColor} weight="fill" />
                                              <Box sx={{ minWidth: 0, flex: 1 }}>
                                                <Typography variant="caption" sx={{ fontWeight: 600, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                  {model.name}
                                                </Typography>
                                                <Typography variant="caption" color="text.secondary" sx={{ fontSize: 8 }}>
                                                  {model.refKey}
                                                </Typography>
                                              </Box>
                                            </Box>
                                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.25, flexShrink: 0 }}>
                                              {model.reasoning && <Chip label={t('model.reasoning_badge')} size="small" color="warning" sx={{ fontSize: 7, height: 12, minWidth: 12 }} />}
                                              {model.inputTypes.includes('image') && <Chip label={t('model.image_badge')} size="small" color="info" sx={{ fontSize: 7, height: 12, minWidth: 12 }} />}
                                              {!modelChatUsable(config, model.id) && <Chip label={t('model.nonchat_badge')} size="small" color="default" sx={{ fontSize: 7, height: 12, minWidth: 12, opacity: 0.7 }} />}
                                              {modelTestResult && (
                                                modelTestResult.success
                                                  ? <CheckCircleIcon size={10} color={successColor} weight="fill" />
                                                  : <WarningIcon size={10} color={errorColor} weight="fill" />
                                              )}
                                              {isModelTesting && <CircularProgress size={10} />}
                                              <Tooltip title={t('model.test')}>
                                                <IconButton size="small" sx={{ p: 0.15 }} onClick={(e) => { e.stopPropagation(); handleTestModel(model.id); }}>
                                                  <PlayIcon size={10} />
                                                </IconButton>
                                              </Tooltip>
                                              <IconButton size="small" sx={{ p: 0.15 }} onClick={() => setModelDialog({ open: true, data: model, endpointId: endpoint.id })}>
                                                <PencilSimpleIcon size={10} />
                                              </IconButton>
                                              <IconButton size="small" sx={{ p: 0.15 }} onClick={() => {
                                                const affectedAgents = agents.filter(a =>
                                                  a.modelId === model.id || a.fallbackModelId === model.id
                                                );
                                                let msg = t('model.delete_confirm', { name: model.name });
                                                if (affectedAgents.length > 0) {
                                                  msg += '\n\n' + t('provider.delete_affected_agents', {
                                                    count: affectedAgents.length,
                                                    names: affectedAgents.map(a => a.name).join(', '),
                                                    defaultValue: `This will affect ${affectedAgents.length} agent(s): ${affectedAgents.map(a => a.name).join(', ')}`,
                                                  });
                                                }
                                                setDeleteConfirm({
                                                  open: true,
                                                  title: t('model.delete'),
                                                  message: msg,
                                                  onConfirm: async () => {
                                                    await deleteModel(model.id);
                                                    setDeleteConfirm({ open: false, title: '', message: '', onConfirm: () => {} });
                                                  },
                                                });
                                              }}>
                                                <TrashIcon size={10} color={errorColor} />
                                              </IconButton>
                                            </Box>
                                          </Box>
                                        );
                                      })}
                                    </Box>
                                  )}
                                </Box>
                              </Collapse>
                            </Card>
                          );
                        })}
                      </Box>
                    )}
                  </Box>
                </Collapse>
              </Card>
            );
          })}
        </Box>
      )}

      <ProviderDialog
        open={providerDialog.open}
        onClose={() => setProviderDialog({ open: false, data: null })}
        onSave={saveProvider}
        initial={providerDialog.data}
      />

      <EndpointDialog
        open={endpointDialog.open}
        onClose={() => setEndpointDialog({ open: false, data: null, providerId: '' })}
        onSave={saveEndpoint}
        initial={endpointDialog.data}
        providerId={endpointDialog.providerId}
      />

      <ModelDialog
        open={modelDialog.open}
        onClose={() => setModelDialog({ open: false, data: null, endpointId: '' })}
        onSave={saveModel}
        initial={modelDialog.data}
        endpointId={modelDialog.endpointId}
      />

      <ConfirmDialog
        open={deleteConfirm.open}
        title={deleteConfirm.title}
        message={deleteConfirm.message}
        onConfirm={deleteConfirm.onConfirm}
        onCancel={() => setDeleteConfirm({ open: false, title: '', message: '', onConfirm: () => {} })}
        cancelLabel={t('dialog.cancel')}
        confirmLabel={t('dialog.confirm_delete')}
      />

      <Snackbar
        open={snackbar.open}
        autoHideDuration={3000}
        onClose={() => setSnackbar({ ...snackbar, open: false })}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert severity={snackbar.severity} onClose={() => setSnackbar({ ...snackbar, open: false })} variant="filled" sx={{ fontSize: 12 }}>
          {snackbar.message}
        </Alert>
      </Snackbar>
    </Box>
  );
}
