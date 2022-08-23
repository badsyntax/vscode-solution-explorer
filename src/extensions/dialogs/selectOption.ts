import * as vscode from "vscode";
import { WizardContext } from "./WizardContext";

export type ItemsResolver = () => Promise<string[]>;

export type MapItemsResolver = () => Promise<{ [id: string]: string }>;

export type ItemsOrItemsResolver = string[] | ItemsResolver | { [id: string]: string } | MapItemsResolver;

export function selectOption(placeholder: string, items: ItemsOrItemsResolver): Promise<string | undefined>;
export function selectOption(placeholder: string, items: ItemsOrItemsResolver, selected: string): Promise<string | undefined>;
export function selectOption(placeholder: string, items: ItemsOrItemsResolver, wizard: WizardContext): Promise<string | undefined>;
export function selectOption(placeholder: string, items: ItemsOrItemsResolver, selected: string, wizard: WizardContext): Promise<string | undefined>;
export async function selectOption(placeholder: string, items: ItemsOrItemsResolver, selected?: string | WizardContext, wizard?: WizardContext): Promise<string | undefined> {
    if (selected && typeof selected !== "string") {
        wizard = selected;
        selected = undefined;
    }

    if (typeof(items) === 'function') {
        items = await items();
    }

    const validate: (value: string) => boolean = value => {
        if (value !== null && value !== undefined) {
            return true;
        }

        return false;
    };

    const getItemValue = (value: string): string | undefined => {
        if (Array.isArray(items)) { return value; }
        if (typeof items === 'object') { return items[value]; }
    }

    const options = Array.isArray(items) ? items : Object.keys(items);
    if (options.length <= 0) {
        wizard?.next();
        return;
    }

    if (options.length === 1) {
        wizard?.next();
        return getItemValue(options[0]);
    }

    options.sort((a, b) => {
        let x = a.toLowerCase();
        let y = b.toLowerCase();
        return x < y ? -1 : x > y ? 1 : 0;
    });

    const result = new Promise<string | undefined>((resolve, reject) => {
        let accepted = false;
        const input = vscode.window.createQuickPick();
        input.title = wizard?.title;
        input.step = wizard ? wizard.step + 1 : undefined;
        input.totalSteps = wizard?.totalSteps;
        input.placeholder = placeholder;
        input.canSelectMany = false;
        input.items = options.map(s => { return { label: s } as vscode.QuickPickItem; });
        input.value = selected as string || "";

        input.onDidTriggerButton(item => {
            if (item === vscode.QuickInputButtons.Back) {
                wizard?.prev();
                resolve(input.activeItems[0].label);
            } else {
                if (validate(input.activeItems[0].label)) {
                    accepted = true;
                    wizard?.next();
                    resolve(getItemValue(input.activeItems[0].label));
                } else  {
                    wizard?.cancel();
                    resolve(undefined);
                }
            }
        });

        input.onDidAccept(() => {
            if (validate(input.activeItems[0].label)) {
                accepted = true;
                wizard?.next();
                resolve(getItemValue(input.activeItems[0].label));
            } else {
                wizard?.cancel();
                resolve(undefined);
            }
        });

        input.onDidHide(() => {
            if (!accepted) {
                wizard?.cancel();
                resolve(undefined);
            }
        });

        input.show();
    });

    return await result;
}