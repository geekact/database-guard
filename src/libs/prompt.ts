import { confirm, input, password, select } from '@inquirer/prompts';

export const askYesNo = async (question: string, defaultYes = false): Promise<boolean> =>
  confirm({
    message: question,
    default: defaultYes,
  });

export const askInput = async (
  question: string,
  options: {
    defaultValue?: string;
    validate?: (value: string) => boolean | string | Promise<boolean | string>;
  } = {},
): Promise<string> =>
  input({
    message: question,
    ...(options.defaultValue ? { default: options.defaultValue } : {}),
    ...(options.validate ? { validate: options.validate } : {}),
  });

/** 密码输入（掩码）；回车为空时使用 defaultValue */
export const askPassword = async (
  question: string,
  options: {
    defaultValue?: string;
    validate?: (value: string) => boolean | string | Promise<boolean | string>;
  } = {},
): Promise<string> => {
  const value = await password({
    message: options.defaultValue !== undefined ? `${question}（回车使用默认值）` : question,
    mask: '*',
    validate: async (inputValue) => {
      const resolved = inputValue || options.defaultValue || '';
      if (options.validate) return options.validate(resolved);
      return true;
    },
  });
  return value || options.defaultValue || '';
};

export const askSelect = async <T extends string>(
  question: string,
  choices: T[],
  defaultIndex = 0,
): Promise<T> => {
  if (!choices.length) {
    throw new Error('没有可选项目');
  }

  return select({
    message: question,
    choices: choices.map((choice) => ({ name: choice, value: choice })),
    default: choices[defaultIndex],
  });
};
