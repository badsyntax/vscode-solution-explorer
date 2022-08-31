import * as path from "@extensions/path";
import * as fs from "@extensions/fs";
import * as xml from "@extensions/xml";
import { XmlElement } from "@extensions/xml";
import * as config from "@extensions/config";
import { Include, ProjectItem, ProjectItemsFactory } from "../Items";
import { ProjectFileStat } from "../ProjectFileStat";
import { Manager } from "./Manager";

export class XmlManager implements Manager {
    private readonly projectFolderPath: string;
    private document: XmlElement | undefined;
    private projectItems: ProjectItem[] = [];
    private currentItemGroup: xml.XmlElement | undefined = undefined;
    private isCpsProject: boolean = false;

    constructor(private readonly fullPath: string, private readonly includePrefix?: string) {
        this.projectFolderPath = path.dirname(fullPath);
    }

    public get isCps(): boolean {
        return this.isCpsProject;
    }

    public async createFile(folderpath: string, filename: string, content?: string): Promise<string> {
        await this.ensureIsLoaded();

        const folderRelativePath = this.getRelativePath(folderpath);
        const relativePath = path.join(folderRelativePath, filename);
        const extension = path.extname(relativePath)?.substring(1);
        const itemTypes = config.getItemTypes();
        let type = 'None';
        if (itemTypes[extension]) {
            type = itemTypes[extension];
        } else {
            type = itemTypes['*'];
        }

        if (!type) {
            type = 'None';
        }

        if (folderRelativePath) {
            // maybe the folder was empty
            this.removeInNodes(folderRelativePath, true, ['Folder']);
        }

        const fullPath = path.join(this.projectFolderPath, relativePath);
        if (!this.isCurrentlyIncluded(fullPath)) {
            this.currentItemGroupAdd(type, relativePath);
        }

        await this.saveProject();
        return relativePath;
    }

    public async createFolder(folderpath: string): Promise<string> {
        await this.ensureIsLoaded();

        let folderRelativePath = this.getRelativePath(folderpath);
        let parentRelativePath = path.dirname(folderRelativePath);
        if (parentRelativePath) {
            // maybe the container folder was empty
            this.removeInNodes(parentRelativePath, true, ['Folder']);
        }

        const fullPath = path.join(this.projectFolderPath, folderRelativePath);
        if (!this.isCurrentlyIncluded(fullPath)) {
            this.currentItemGroupAdd('Folder', folderRelativePath, true);
        }

        await this.saveProject();
        return folderRelativePath;
    }

    public async deleteFile(filepath: string): Promise<void> {
        await this.ensureIsLoaded();

        const relativePath = this.getRelativePath(filepath);
        const folderRelativePath = path.dirname(relativePath);
        this.removeInNodes(relativePath);
        if (folderRelativePath !== '.' && this.countInNodes(folderRelativePath, true) === 0) {
            this.currentItemGroupAdd('Folder', folderRelativePath, true);
        }

        await this.saveProject();
    }

    public async deleteFolder(folderpath: string): Promise<void> {
        await this.ensureIsLoaded();

        const folderRelativePath = this.getRelativePath(folderpath);
        this.removeInNodes(folderRelativePath, true);
        await this.saveProject();
    }

    public async moveFile(filepath: string, newfolderPath: string): Promise<string> {
        await this.ensureIsLoaded();

        const relativePath = this.getRelativePath(filepath);
        const newRelativePath = this.getRelativePath(newfolderPath);
        this.renameInNodes(relativePath, newRelativePath);
        await this.saveProject();
        return newRelativePath;
    }

    public async moveFolder(folderpath: string, newfolderPath: string): Promise<string> {
        await this.ensureIsLoaded();

        const relativePath = this.getRelativePath(folderpath);
        const newRelativePath = this.getRelativePath(newfolderPath);
        this.renameInNodes(relativePath, newRelativePath, true);
        await this.saveProject();
        return newRelativePath;
    }

    public async renameFile(filepath: string, name: string): Promise<string> {
        await this.ensureIsLoaded();

        const relativePath = this.getRelativePath(filepath);
        const newRelativePath = path.join(path.dirname(relativePath), name);
        this.renameInNodes(relativePath, newRelativePath);
        await this.saveProject();
        return newRelativePath;
    }

    public async renameFolder(folderpath: string, name: string): Promise<string> {
        await this.ensureIsLoaded();

        const relativePath = this.getRelativePath(folderpath);
        const newRelativePath = path.join(path.dirname(relativePath), name);
        this.renameInNodes(relativePath, newRelativePath, true);
        await this.saveProject();
        return newRelativePath;
    }

    public statFile(filepath: string, folderPath: string): Promise<ProjectFileStat> {
        throw new Error("Method not implemented.");
    }

    public async refresh(): Promise<void> {
        const content = await fs.readFile(this.fullPath);
        this.document = await xml.parseToJson(content);
        this.projectItems = this.parseDocument();
    }

    public async getProjectItems(): Promise<ProjectItem[]> {
        await this.ensureIsLoaded();
        return this.projectItems;
    }

    private countInNodes(pattern: string, isFolder: boolean = false): number {
        if (!this.document) { return 0; }

        pattern = pattern.replace(/\//g, '\\') + (isFolder ? '\\' : '');
        if (this.includePrefix) { pattern = this.includePrefix + pattern; }

        let counter = 0;
        const findPattern = (ref: xml.XmlElement) => {
            if (ref.attributes.Include.startsWith(pattern)) {
                counter++;
            }
        };

        const nodeNames = this.getXmlNodeNames();
        const project = XmlManager.getProjectElement(this.document);
        if (!project) { return 0; }

        project.elements.forEach((element: xml.XmlElement) => {
            if (element.name === 'ItemGroup') {
                if (!element.elements || !Array.isArray(element.elements)) {
                    element.elements = [];
                }

                element.elements.forEach((e: xml.XmlElement) => {
                    nodeNames.forEach(nodeName => {
                        if (e.name === nodeName) {
                            findPattern(e);
                        }
                    });
                });
            }
        });

        return counter;
    }

    private renameInNodes(pattern: string, newPattern: string, isFolder: boolean = false): void {
        if (!this.document) { return; }

        pattern = pattern.replace(/\//g, '\\') + (isFolder ? '\\' : '');
        newPattern = newPattern.replace(/\//g, '\\') + (isFolder ? '\\' : '');

        if (this.includePrefix) {
            pattern = this.includePrefix + pattern;
            newPattern = this.includePrefix + newPattern;
        }

        let findPattern = (ref: xml.XmlElement) => {
            this.replaceDependsUponNode(ref, pattern, newPattern);

            if (ref.attributes.Include.startsWith(pattern)) {
                ref.attributes.Include = ref.attributes.Include.replace(pattern, newPattern);
            }
        };

        let nodeNames = this.getXmlNodeNames();
        let project = XmlManager.getProjectElement(this.document);
        if (!project) { return; }

        project.elements.forEach((element: xml.XmlElement) => {
            if (element.name === 'ItemGroup') {
                if (!element.elements || !Array.isArray(element.elements)) {
                    element.elements = [];
                }

                element.elements.forEach((e: xml.XmlElement) => {
                    nodeNames.forEach(nodeName => {
                        if (e.name === nodeName) {
                            findPattern(e);
                        }
                    });
                });
            }
        });
    }

    protected replaceDependsUponNode(ref: xml.XmlElement, pattern: string, newPattern: string) {
        if (!ref.elements) { return; }

        ref.elements.forEach((e: xml.XmlElement) => {
            if (e.name === 'DependentUpon' && e.elements[0].text.startsWith(pattern)) {
                e.elements[0].text = e.elements[0].text.replace(pattern, newPattern);
            }
        });
    }

    private removeInNodes(pattern: string, isFolder: boolean = false, types: string[] | null = null): void {
        if (!this.document) { return; }

        pattern = pattern.replace(/\//g, '\\') + (isFolder ? '\\' : '');
        if (this.includePrefix) {
            pattern = this.includePrefix + pattern;
        }

        if (!types) {
            types = this.getXmlNodeNames();
        }

        const project = XmlManager.getProjectElement(this.document);
        if (!project) { return; }

        project.elements.forEach((element: xml.XmlElement, elementIndex: number) => {
            if (element.name === 'ItemGroup') {
                XmlManager.ensureElements(element);
                const toDelete: xml.XmlElement[] = [];
                element.elements.forEach((e: xml.XmlElement) => {
                    if (types === null) { return; }
                    types.forEach(nodeName => {
                        if (e.name === nodeName) {
                            this.deleteDependsUponNode(e, pattern);
                            if (e.attributes.Include.startsWith(pattern)) {
                                toDelete.push(e);
                            }
                        }
                    });
                });

                toDelete.forEach(e => {
                    element.elements.splice(element.elements.indexOf(e), 1);
                });


                if (element.elements.length === 0) {
                    project.elements.splice(elementIndex, 1);
                }
            }
        });
    }

    protected deleteDependsUponNode(node: xml.XmlElement, pattern: string) {
        if (!node.elements) { return; }

        node.elements.forEach((e: xml.XmlElement, eIndex: number) => {
            if (e.name === 'DependentUpon' && e.elements[0].text.startsWith(pattern)) {
                node.elements.splice(eIndex, 1);
            }
        });

        if (node.elements.length === 0) {
            delete node.elements;
        }
    }

    private currentItemGroupAdd(type: string, include: string, isFolder: boolean = false): void {
        const itemGroup = this.checkCurrentItemGroup();
        if (!itemGroup) { return; }

        include = include.replace(/\//g, '\\') + (isFolder ? '\\' : '');

        if (this.includePrefix) {
            include = this.includePrefix + include;
        }

        itemGroup.elements.push({
            type: 'element',
            name: type,
            attributes: {
                ["Include"]: include
            }
        });
    }

    private checkCurrentItemGroup(): XmlElement | undefined {
        if (!this.document) { return; }

        const project = XmlManager.getProjectElement(this.document);
        if (!project) { return; }

        let current: xml.XmlElement | undefined;
        let lastElement: xml.XmlElement | undefined;
        project.elements.forEach((element: xml.XmlElement) => {
            if (element.name === 'ItemGroup') {
                lastElement = element;
            }
            if (this.currentItemGroup && element === this.currentItemGroup) {
                current = element;
            }
        });

        if (!current && !lastElement) {
            current = {
                type: 'element',
                name: 'ItemGroup',
                elements: []
            };
            project.elements.push(current);
        } else if (!current) {
            current = lastElement;
        }

        this.currentItemGroup = current;
        return current;
    }

    private async ensureIsLoaded(): Promise<void> {
        if (!this.document) {
            await this.refresh();
        }
    }

    private parseDocument(): ProjectItem[] {
        if (!this.document) { return []; }

        const project = XmlManager.getProjectElement(this.document);
        if (!project) { return []; }

        const result: ProjectItem[] = [];
        if ((this.isCpsProject = project.attributes && project.attributes.Sdk)) {
            const exclude = [...config.getNetCoreIgnore(), this.fullPath].join(";");
            const allFolders = new Include("Compile", "**/*", undefined, undefined, exclude);
            result.push(allFolders);
        }

        project.elements.forEach((element: XmlElement) => {
            if (element.name === 'ItemGroup') {
                XmlManager.ensureElements(element);
                element.elements.forEach((e: XmlElement) => {
                    const projectItem = ProjectItemsFactory.createProjectElement(e, this.includePrefix);
                    if (!projectItem) {
                        return;
                    }

                    result.push(projectItem);
                });
            }
        });

        return result;
    }

    private async saveProject(): Promise<void> {
        if (!this.document) { return; }

        let content = await xml.parseToXml(this.document);
        await fs.writeFile(this.fullPath, content);
    }

    private isCurrentlyIncluded(sourcePath: string): boolean {
        for (const item of this.projectItems) {
            if (item.isPathIncluded(this.projectFolderPath, sourcePath)) {
                return true;
            }
        }

        return false;
    }

    private isCurrentlyRemoved(sourcePath: string): boolean {
        for (const item of this.projectItems) {
            if (item.isPathRemoved(this.projectFolderPath, sourcePath)) {
                return true;
            }
        }

        return false;
    }

    private getRelativePath(fullpath: string): string {
        return path.relative(path.dirname(this.fullPath), fullpath);
    }

    private getXmlNodeNames(): string[] {
        let result: string[] = [
            "Compile",
            "ClCompile",
            "ClInclude",
            "Content",
            "TypeScriptCompile",
            "CustomBuild",
            "EmbeddedResource",
            "None",
            "Folder"
        ];

        const itemTypes = config.getItemTypes();
        Object.keys(itemTypes).forEach(key => {
            if (result.indexOf(itemTypes[key]) < 0) {
                result.push(itemTypes[key]);
            }
        });

        return result;
    }

    public static getProjectElement(document: XmlElement): XmlElement | undefined {
        if (document && document.elements) {
            if (document.elements.length === 1) {
                return XmlManager.ensureElements(document.elements[0]);
            } else {
                for (let i = 0; i < document.elements.length; i++) {
                    if (document.elements[i].type !== 'comment') {
                        return XmlManager.ensureElements(document.elements[i]);
                    }
                }
            }
        }
    }

    private static ensureElements(element: XmlElement): XmlElement {
        if (!element.elements || !Array.isArray(element.elements)) {
            element.elements = [];
        }

        return element;
    }
}
