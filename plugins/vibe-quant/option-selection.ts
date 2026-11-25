import catalog from './sdk/quant_sdk/option_profiles.json' with { type: 'json' };

export const optionProfiles = catalog.profiles;
export const ivLimits = catalog.iv_limits;
export type OptionProfile = keyof typeof optionProfiles;
export type IvPreference = keyof typeof ivLimits;

export const profileIds = ['moderate', 'balanced', 'aggressive'] as const;
export const ivPreferenceIds = ['strict', 'standard', 'flexible'] as const;
export const profileNames: Record<OptionProfile, string> = {
  moderate: '温和',
  balanced: '均衡',
  aggressive: '激进',
};
export const ivNames: Record<IvPreference, string> = {
  strict: '只选偏低',
  standard: '接受适度溢价',
  flexible: '接受较高溢价',
};

export function defaultIv(profile: OptionProfile): IvPreference {
  return optionProfiles[profile].iv_preference as IvPreference;
}

export function optionSelectionLabel(value: {
  profile?: OptionProfile;
  target_leverage: number;
  iv_preference?: IvPreference;
}) {
  if (!value.profile) return `仅按倍率 · 目标 ${value.target_leverage} 倍`;
  return `${profileNames[value.profile]} · ${ivNames[value.iv_preference ?? defaultIv(value.profile)]} · 目标 ${value.target_leverage} 倍`;
}
