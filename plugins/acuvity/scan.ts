import {
  HookEventType,
  PluginContext,
  PluginHandler,
  PluginParameters,
} from '../types';
import {
  getApexUrlFromToken,
  ResponseHelper,
  GuardName,
  GuardResult,
} from './helper';
import { getText, post } from '../utils';

interface ScanRequest {
  anonymization: 'FixedSize';
  messages: string[];
  redactions: string[];
  type: 'Input' | 'Output';
}

const getRedactionList = (parameters: PluginParameters): string[] => {
  const redactions: string[] = [];

  if (parameters.pii && parameters.pii_redact && parameters.pii_categories) {
    for (const category of parameters.pii_categories) {
      redactions.push(category);
    }
  }

  if (
    parameters.secrets &&
    parameters.secrets_redact &&
    parameters.secrets_categories
  ) {
    for (const category of parameters.secrets.categories) {
      redactions.push(category);
    }
  }

  return redactions;
};

export const postAcuvityScan = async (
  base_url: string,
  apiKey: string,
  text: string,
  eventType: HookEventType,
  redactions: string[]
) => {
  const data: ScanRequest = {
    anonymization: 'FixedSize',
    messages: [text],
    redactions: redactions,
    type: eventType === 'beforeRequestHook' ? 'Input' : 'Output',
  };

  const options = {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  };

  return post(`${base_url}/_acuvity/scan`, data, options);
};

export const handler: PluginHandler = async (
  context: PluginContext,
  parameters: PluginParameters,
  eventType: HookEventType
) => {
  let error = null;
  let verdict = true;
  let data = null;

  try {
    if (!parameters.credentials) {
      throw new Error('acuvity api key not given');
    }

    const text = getText(context, eventType);

    let token = parameters.credentials.apiKey;
    let base_url = getApexUrlFromToken(token);

    if (!base_url) {
      throw new Error('acuvity base url not given');
    }

    const result: any = await postAcuvityScan(
      base_url,
      token,
      text,
      eventType,
      getRedactionList(parameters)
    );

    const responseHelper = new ResponseHelper();

    // Loop through all extractions
    for (const extraction of result.extractions) {
      // Evaluate parameters for current extraction
      const results = evaluateAllParameters(
        extraction,
        parameters,
        responseHelper
      );

      data = results;
      // Check if any parameter check failed in this extraction
      for (const { result } of results) {
        if (result.matched) {
          verdict = false;
          break;
        }
      }

      if (!verdict) {
        break;
      }
    }
  } catch (e: any) {
    delete e.stack;
    error = e;
  }

  return { error, verdict, data };
};

function evaluateAllParameters(
  extraction: any,
  parameters: PluginParameters,
  responseHelper: ResponseHelper
): Array<{ parameter: string; result: GuardResult }> {
  const results: Array<{ parameter: string; result: GuardResult }> = [];

  // Check prompt injection
  if (parameters.prompt_injection) {
    results.push({
      parameter: 'prompt_injection',
      result: responseHelper.evaluate(
        extraction,
        GuardName.PROMPT_INJECTION,
        parameters.prompt_injection_threshold || 0.5
      ),
    });
  }

  // Check toxic content
  if (parameters.toxic) {
    results.push({
      parameter: 'toxic',
      result: responseHelper.evaluate(
        extraction,
        GuardName.TOXIC,
        parameters.toxic_threshold || 0.5
      ),
    });
  }

  // Check jailbreak
  if (parameters.jail_break) {
    results.push({
      parameter: 'jail_break',
      result: responseHelper.evaluate(
        extraction,
        GuardName.JAIL_BREAK,
        parameters.jail_break_threshold || 0.5
      ),
    });
  }

  // Check malicious URL
  if (parameters.malicious_url) {
    results.push({
      parameter: 'malicious_url',
      result: responseHelper.evaluate(
        extraction,
        GuardName.MALICIOUS_URL,
        parameters.malicious_url_threshold || 0.5
      ),
    });
  }

  // Check bias
  if (parameters.biased) {
    results.push({
      parameter: 'biased',
      result: responseHelper.evaluate(
        extraction,
        GuardName.BIASED,
        parameters.biased_threshold || 0.5
      ),
    });
  }

  // Check harmful content
  if (parameters.harmful) {
    results.push({
      parameter: 'harmful',
      result: responseHelper.evaluate(
        extraction,
        GuardName.HARMFUL_CONTENT,
        parameters.harmful_threshold || 0.5
      ),
    });
  }

  // Check language
  if (parameters.language && parameters.languagevals) {
    results.push({
      parameter: 'language',
      result: responseHelper.evaluate(
        extraction,
        GuardName.LANGUAGE,
        0.5, // Language check typically uses a fixed threshold
        parameters.languagevals
      ),
    });
  }

  // Check PII
  if (parameters.pii && parameters.pii_categories) {
    // Iterate through each PII category
    for (const category of parameters.pii_categories) {
      results.push({
        parameter: `pii_${category.toLowerCase()}`,
        result: responseHelper.evaluate(
          extraction,
          GuardName.PII_DETECTOR,
          0.5, // PII typically uses a fixed threshold
          category.toLowerCase()
        ),
      });
    }
  }

  // Check Secrets
  if (parameters.secrets && parameters.secrets_categories) {
    // Iterate through each secrets category
    for (const category of parameters.secrets_categories) {
      results.push({
        parameter: `secrets_${category.toLowerCase()}`,
        result: responseHelper.evaluate(
          extraction,
          GuardName.SECRETS_DETECTOR,
          0.5, // PII typically uses a fixed threshold
          category.toLowerCase()
        ),
      });
    }
  }

  return results;
}
